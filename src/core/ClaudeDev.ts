import { Anthropic } from "@anthropic-ai/sdk"
import { PromptCachingBetaMessageStream } from "@anthropic-ai/sdk/lib/PromptCachingBetaMessageStream.mjs"
import { JSONParser, TokenType } from "@streamparser/json"
import delay from "delay"
import * as diff from "diff"
import fs from "fs/promises"
import os from "os"
import pWaitFor from "p-wait-for"
import * as path from "path"
import { serializeError } from "serialize-error"
import * as vscode from "vscode"
import { AnthropicStream, ApiHandler, buildApiHandler } from "../api"
import { diagnosticsToProblemsString, getNewDiagnostics } from "../integrations/diagnostics"
import { formatContentBlockToMarkdown } from "../integrations/misc/export-markdown"
import { extractTextFromFile } from "../integrations/misc/extract-text"
import { TerminalManager } from "../integrations/terminal/TerminalManager"
import { UrlContentFetcher } from "../services/browser/UrlContentFetcher"
import { listFiles } from "../services/glob/list-files"
import { regexSearchFiles } from "../services/ripgrep"
import { parseSourceCodeForDefinitionsTopLevel } from "../services/tree-sitter"
import { ApiConfiguration } from "../shared/api"
import { combineApiRequests } from "../shared/combineApiRequests"
import { combineCommandSequences } from "../shared/combineCommandSequences"
import { ClaudeAsk, ClaudeMessage, ClaudeSay, ClaudeSayTool } from "../shared/ExtensionMessage"
import { getApiMetrics } from "../shared/getApiMetrics"
import { HistoryItem } from "../shared/HistoryItem"
import { ToolName } from "../shared/Tool"
import { ClaudeAskResponse } from "../shared/WebviewMessage"
import { findLast, findLastIndex } from "../shared/array"
import { arePathsEqual } from "../utils/path"
import { parseMentions } from "./mentions"
import { SYSTEM_PROMPT } from "./prompts/system"
import { TOOLS } from "./prompts/tools"
import { truncateHalfConversation } from "./sliding-window"
import { ClaudeDevProvider } from "./webview/ClaudeDevProvider"
import cloneDeep from "clone-deep"
import {
	AssistantMessageContent,
	TextContent,
	ToolCall,
	ToolCallName,
	toolCallNames,
	ToolParamName,
	toolParamNames,
} from "./AssistantMessage"

const cwd =
	vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0) ?? path.join(os.homedir(), "Desktop") // may or may not exist but fs checking existence would immediately ask for permission which would be bad UX, need to come up with a better solution

type ToolResponse = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>
type UserContent = Array<
	Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam
>

// type AnthropicPartialContentBlock = Anthropic.Messages.ContentBlock & {
// 	partial?: boolean
// }

export class ClaudeDev {
	readonly taskId: string
	private api: ApiHandler
	private terminalManager: TerminalManager
	private urlContentFetcher: UrlContentFetcher
	private didEditFile: boolean = false
	private customInstructions?: string
	private alwaysAllowReadOnly: boolean
	apiConversationHistory: Anthropic.MessageParam[] = []
	claudeMessages: ClaudeMessage[] = []
	private askResponse?: ClaudeAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	private lastMessageTs?: number
	private consecutiveMistakeCount: number = 0
	private providerRef: WeakRef<ClaudeDevProvider>
	private abort: boolean = false

	constructor(
		provider: ClaudeDevProvider,
		apiConfiguration: ApiConfiguration,
		customInstructions?: string,
		alwaysAllowReadOnly?: boolean,
		task?: string,
		images?: string[],
		historyItem?: HistoryItem
	) {
		this.providerRef = new WeakRef(provider)
		this.api = buildApiHandler(apiConfiguration)
		this.terminalManager = new TerminalManager()
		this.urlContentFetcher = new UrlContentFetcher(provider.context)
		this.customInstructions = customInstructions
		this.alwaysAllowReadOnly = alwaysAllowReadOnly ?? false

		if (historyItem) {
			this.taskId = historyItem.id
			this.resumeTaskFromHistory()
		} else if (task || images) {
			this.taskId = Date.now().toString()
			this.startTask(task, images)
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}
	}

	updateApi(apiConfiguration: ApiConfiguration) {
		this.api = buildApiHandler(apiConfiguration)
	}

	updateCustomInstructions(customInstructions: string | undefined) {
		this.customInstructions = customInstructions
	}

	updateAlwaysAllowReadOnly(alwaysAllowReadOnly: boolean | undefined) {
		this.alwaysAllowReadOnly = alwaysAllowReadOnly ?? false
	}

	async handleWebviewAskResponse(askResponse: ClaudeAskResponse, text?: string, images?: string[]) {
		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images
	}

	// storing task to disk for history

	private async ensureTaskDirectoryExists(): Promise<string> {
		const globalStoragePath = this.providerRef.deref()?.context.globalStorageUri.fsPath
		if (!globalStoragePath) {
			throw new Error("Global storage uri is invalid")
		}
		const taskDir = path.join(globalStoragePath, "tasks", this.taskId)
		await fs.mkdir(taskDir, { recursive: true })
		return taskDir
	}

	private async getSavedApiConversationHistory(): Promise<Anthropic.MessageParam[]> {
		const filePath = path.join(await this.ensureTaskDirectoryExists(), "api_conversation_history.json")
		const fileExists = await fs
			.access(filePath)
			.then(() => true)
			.catch(() => false)
		if (fileExists) {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		}
		return []
	}

	private async addToApiConversationHistory(message: Anthropic.MessageParam) {
		this.apiConversationHistory.push(message)
		await this.saveApiConversationHistory()
	}

	private async overwriteApiConversationHistory(newHistory: Anthropic.MessageParam[]) {
		this.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	private async saveApiConversationHistory() {
		try {
			const filePath = path.join(await this.ensureTaskDirectoryExists(), "api_conversation_history.json")
			await fs.writeFile(filePath, JSON.stringify(this.apiConversationHistory))
		} catch (error) {
			// in the off chance this fails, we don't want to stop the task
			console.error("Failed to save API conversation history:", error)
		}
	}

	private async getSavedClaudeMessages(): Promise<ClaudeMessage[]> {
		const filePath = path.join(await this.ensureTaskDirectoryExists(), "claude_messages.json")
		const fileExists = await fs
			.access(filePath)
			.then(() => true)
			.catch(() => false)
		if (fileExists) {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		}
		return []
	}

	private async addToClaudeMessages(message: ClaudeMessage) {
		this.claudeMessages.push(message)
		await this.saveClaudeMessages()
	}

	private async overwriteClaudeMessages(newMessages: ClaudeMessage[]) {
		this.claudeMessages = newMessages
		await this.saveClaudeMessages()
	}

	private async saveClaudeMessages() {
		console.log("Saving claude messages...")
		try {
			const filePath = path.join(await this.ensureTaskDirectoryExists(), "claude_messages.json")
			await fs.writeFile(filePath, JSON.stringify(this.claudeMessages))
			// combined as they are in ChatView
			const apiMetrics = getApiMetrics(combineApiRequests(combineCommandSequences(this.claudeMessages.slice(1))))
			const taskMessage = this.claudeMessages[0] // first message is always the task say
			const lastRelevantMessage =
				this.claudeMessages[
					findLastIndex(
						this.claudeMessages,
						(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")
					)
				]
			await this.providerRef.deref()?.updateTaskHistory({
				id: this.taskId,
				ts: lastRelevantMessage.ts,
				task: taskMessage.text ?? "",
				tokensIn: apiMetrics.totalTokensIn,
				tokensOut: apiMetrics.totalTokensOut,
				cacheWrites: apiMetrics.totalCacheWrites,
				cacheReads: apiMetrics.totalCacheReads,
				totalCost: apiMetrics.totalCost,
			})
		} catch (error) {
			console.error("Failed to save claude messages:", error)
		}
	}

	// partial has three valid states true (partial message), false (completion of partial message), undefined (individual complete message)
	async ask(
		type: ClaudeAsk,
		text?: string,
		partial?: boolean
	): Promise<{ response: ClaudeAskResponse; text?: string; images?: string[] }> {
		// If this ClaudeDev instance was aborted by the provider, then the only thing keeping us alive is a promise still running in the background, in which case we don't want to send its result to the webview as it is attached to a new instance of ClaudeDev now. So we can safely ignore the result of any active promises, and this class will be deallocated. (Although we set claudeDev = undefined in provider, that simply removes the reference to this instance, but the instance is still alive until this promise resolves or rejects.)
		if (this.abort) {
			throw new Error("ClaudeDev instance aborted")
		}
		let askTs: number
		if (partial !== undefined) {
			const lastMessage = this.claudeMessages.at(-1)
			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type
			if (partial) {
				if (isUpdatingPreviousPartial) {
					// existing partial message, so update it
					lastMessage.text = text
					lastMessage.partial = partial
					// todo be more efficient about saving and posting only new data or one whole message at a time so ignore partial for saves, and only post parts of partial message instead of whole array in new listener
					// await this.saveClaudeMessages()
					// await this.providerRef.deref()?.postStateToWebview()
					await this.providerRef
						.deref()
						?.postMessageToWebview({ type: "partialMessage", partialMessage: lastMessage })
					throw new Error("Current ask promise was ignored")
				} else {
					// this is a new partial message, so add it with partial state
					// this.askResponse = undefined
					// this.askResponseText = undefined
					// this.askResponseImages = undefined
					// askTs = Date.now()
					// this.lastMessageTs = askTs
					await this.addToClaudeMessages({ ts: Date.now(), type: "ask", ask: type, text, partial })
					await this.providerRef.deref()?.postStateToWebview()
					throw new Error("Current ask promise was ignored")
				}
			} else {
				// partial=false means its a complete version of a previously partial message
				if (isUpdatingPreviousPartial) {
					// this is the complete version of a previously partial message, so replace the partial with the complete version
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined
					askTs = Date.now()
					this.lastMessageTs = askTs
					lastMessage.ts = askTs
					lastMessage.text = text
					lastMessage.partial = false
					await this.saveClaudeMessages()
					await this.providerRef.deref()?.postStateToWebview()
				} else {
					// this is a new partial=false message, so add it like normal
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClaudeMessages({ ts: askTs, type: "ask", ask: type, text })
					await this.providerRef.deref()?.postStateToWebview()
				}
			}
		} else {
			// this is a new non-partial message, so add it like normal
			// const lastMessage = this.claudeMessages.at(-1)
			this.askResponse = undefined
			this.askResponseText = undefined
			this.askResponseImages = undefined
			askTs = Date.now()
			this.lastMessageTs = askTs
			await this.addToClaudeMessages({ ts: askTs, type: "ask", ask: type, text })
			await this.providerRef.deref()?.postStateToWebview()
		}

		// if (partial) {
		// 	const lastMessage = this.claudeMessages.at(-1)
		// 	if (lastMessage && lastMessage.type === "ask" && lastMessage.ask === type) {
		// 		lastMessage.text = text
		// 		lastMessage.partial = partial
		// 		// todo be more efficient about saving and posting only new data or one whoe message at atime so ignore partial for saves, and only post parts of partial message instead of whole array in new listener
		// 		await this.saveClaudeMessages()
		// 		await this.providerRef.deref()?.postStateToWebview()
		// 		throw new Error("Current ask promise was ignored")
		// 	}
		// }

		await pWaitFor(() => this.askResponse !== undefined || this.lastMessageTs !== askTs, { interval: 100 })
		if (this.lastMessageTs !== askTs) {
			throw new Error("Current ask promise was ignored") // could happen if we send multiple asks in a row i.e. with command_output. It's important that when we know an ask could fail, it is handled gracefully
		}
		const result = { response: this.askResponse!, text: this.askResponseText, images: this.askResponseImages }
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined
		return result
	}

	async say(type: ClaudeSay, text?: string, images?: string[], partial?: boolean): Promise<undefined> {
		if (this.abort) {
			throw new Error("ClaudeDev instance aborted")
		}

		if (partial !== undefined) {
			const lastMessage = this.claudeMessages.at(-1)
			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type
			if (partial) {
				if (isUpdatingPreviousPartial) {
					// existing partial message, so update it
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = partial
					// await this.saveClaudeMessages()
					// await this.providerRef.deref()?.postStateToWebview()
					await this.providerRef
						.deref()
						?.postMessageToWebview({ type: "partialMessage", partialMessage: lastMessage })
				} else {
					// this is a new partial message, so add it with partial state

					await this.addToClaudeMessages({ ts: Date.now(), type: "say", say: type, text, images, partial })
					await this.providerRef.deref()?.postStateToWebview()
				}
			} else {
				// partial=false means its a complete version of a previously partial message
				if (isUpdatingPreviousPartial) {
					// this is the complete version of a previously partial message, so replace the partial with the complete version
					const sayTs = Date.now()
					this.lastMessageTs = sayTs
					lastMessage.ts = sayTs
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = false

					// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
					await this.saveClaudeMessages()
					await this.providerRef.deref()?.postStateToWebview()
				} else {
					// this is a new partial=false message, so add it like normal
					const sayTs = Date.now()
					this.lastMessageTs = sayTs
					await this.addToClaudeMessages({ ts: sayTs, type: "say", say: type, text, images })
					await this.providerRef.deref()?.postStateToWebview()
				}
			}
		} else {
			// this is a new non-partial message, so add it like normal
			const sayTs = Date.now()
			this.lastMessageTs = sayTs
			await this.addToClaudeMessages({ ts: sayTs, type: "say", say: type, text, images })
			await this.providerRef.deref()?.postStateToWebview()
		}
	}

	private async startTask(task?: string, images?: string[]): Promise<void> {
		// conversationHistory (for API) and claudeMessages (for webview) need to be in sync
		// if the extension process were killed, then on restart the claudeMessages might not be empty, so we need to set it to [] when we create a new ClaudeDev client (otherwise webview would show stale messages from previous session)
		this.claudeMessages = []
		this.apiConversationHistory = []
		await this.providerRef.deref()?.postStateToWebview()

		await this.say("text", task, images)

		let imageBlocks: Anthropic.ImageBlockParam[] = this.formatImagesIntoBlocks(images)
		await this.initiateTaskLoop([
			{
				type: "text",
				text: `<task>\n${task}\n</task>`,
			},
			...imageBlocks,
		])
	}

	private async resumeTaskFromHistory() {
		const modifiedClaudeMessages = await this.getSavedClaudeMessages()

		// Need to modify claude messages for good ux, i.e. if the last message is an api_request_started, then remove it otherwise the user will think the request is still loading
		const lastApiReqStartedIndex = modifiedClaudeMessages.reduce(
			(lastIndex, m, index) => (m.type === "say" && m.say === "api_req_started" ? index : lastIndex),
			-1
		)
		const lastApiReqFinishedIndex = modifiedClaudeMessages.reduce(
			(lastIndex, m, index) => (m.type === "say" && m.say === "api_req_finished" ? index : lastIndex),
			-1
		)
		if (lastApiReqStartedIndex > lastApiReqFinishedIndex && lastApiReqStartedIndex !== -1) {
			modifiedClaudeMessages.splice(lastApiReqStartedIndex, 1)
		}

		// Remove any resume messages that may have been added before
		const lastRelevantMessageIndex = findLastIndex(
			modifiedClaudeMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")
		)
		if (lastRelevantMessageIndex !== -1) {
			modifiedClaudeMessages.splice(lastRelevantMessageIndex + 1)
		}

		await this.overwriteClaudeMessages(modifiedClaudeMessages)
		this.claudeMessages = await this.getSavedClaudeMessages()

		// Now present the claude messages to the user and ask if they want to resume

		const lastClaudeMessage = this.claudeMessages
			.slice()
			.reverse()
			.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")) // could be multiple resume tasks
		// const lastClaudeMessage = this.claudeMessages[lastClaudeMessageIndex]
		// could be a completion result with a command
		// const secondLastClaudeMessage = this.claudeMessages
		// 	.slice()
		// 	.reverse()
		// 	.find(
		// 		(m, index) =>
		// 			index !== lastClaudeMessageIndex && !(m.ask === "resume_task" || m.ask === "resume_completed_task")
		// 	)
		// (lastClaudeMessage?.ask === "command" && secondLastClaudeMessage?.ask === "completion_result")

		let askType: ClaudeAsk
		if (lastClaudeMessage?.ask === "completion_result") {
			askType = "resume_completed_task"
		} else {
			askType = "resume_task"
		}

		const { response, text, images } = await this.ask(askType) // calls poststatetowebview
		let responseText: string | undefined
		let responseImages: string[] | undefined
		if (response === "messageResponse") {
			await this.say("user_feedback", text, images)
			responseText = text
			responseImages = images
		}

		// need to make sure that the api conversation history can be resumed by the api, even if it goes out of sync with claude messages

		// if the last message is an assistant message, we need to check if there's tool use since every tool use has to have a tool response
		// if there's no tool use and only a text block, then we can just add a user message

		// if the last message is a user message, we can need to get the assistant message before it to see if it made tool calls, and if so, fill in the remaining tool responses with 'interrupted'

		const existingApiConversationHistory: Anthropic.Messages.MessageParam[] =
			await this.getSavedApiConversationHistory()

		let modifiedOldUserContent: UserContent // either the last message if its user message, or the user message before the last (assistant) message
		let modifiedApiConversationHistory: Anthropic.Messages.MessageParam[] // need to remove the last user message to replace with new modified user message
		if (existingApiConversationHistory.length > 0) {
			const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

			if (lastMessage.role === "assistant") {
				const content = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				const hasToolUse = content.some((block) => block.type === "tool_use")

				if (hasToolUse) {
					const toolUseBlocks = content.filter(
						(block) => block.type === "tool_use"
					) as Anthropic.Messages.ToolUseBlock[]
					const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
						type: "tool_result",
						tool_use_id: block.id,
						content: "Task was interrupted before this tool call could be completed.",
					}))
					modifiedApiConversationHistory = [...existingApiConversationHistory] // no changes
					modifiedOldUserContent = [...toolResponses]
				} else {
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = []
				}
			} else if (lastMessage.role === "user") {
				const previousAssistantMessage: Anthropic.Messages.MessageParam | undefined =
					existingApiConversationHistory[existingApiConversationHistory.length - 2]

				const existingUserContent: UserContent = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
					const assistantContent = Array.isArray(previousAssistantMessage.content)
						? previousAssistantMessage.content
						: [{ type: "text", text: previousAssistantMessage.content }]

					const toolUseBlocks = assistantContent.filter(
						(block) => block.type === "tool_use"
					) as Anthropic.Messages.ToolUseBlock[]

					if (toolUseBlocks.length > 0) {
						const existingToolResults = existingUserContent.filter(
							(block) => block.type === "tool_result"
						) as Anthropic.ToolResultBlockParam[]

						const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
							.filter(
								(toolUse) => !existingToolResults.some((result) => result.tool_use_id === toolUse.id)
							)
							.map((toolUse) => ({
								type: "tool_result",
								tool_use_id: toolUse.id,
								content: "Task was interrupted before this tool call could be completed.",
							}))

						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1) // removes the last user message
						modifiedOldUserContent = [...existingUserContent, ...missingToolResponses]
					} else {
						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent]
					}
				} else {
					modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
					modifiedOldUserContent = [...existingUserContent]
				}
			} else {
				throw new Error("Unexpected: Last message is not a user or assistant message")
			}
		} else {
			throw new Error("Unexpected: No existing API conversation history")
		}

		let newUserContent: UserContent = [...modifiedOldUserContent]

		const agoText = (() => {
			const timestamp = lastClaudeMessage?.ts ?? Date.now()
			const now = Date.now()
			const diff = now - timestamp
			const minutes = Math.floor(diff / 60000)
			const hours = Math.floor(minutes / 60)
			const days = Math.floor(hours / 24)

			if (days > 0) {
				return `${days} day${days > 1 ? "s" : ""} ago`
			}
			if (hours > 0) {
				return `${hours} hour${hours > 1 ? "s" : ""} ago`
			}
			if (minutes > 0) {
				return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
			}
			return "just now"
		})()

		newUserContent.push({
			type: "text",
			text:
				`Task resumption: This autonomous coding task was interrupted ${agoText}. It may or may not be complete, so please reassess the task context. Be aware that the project state may have changed since then. The current working directory is now '${cwd.toPosix()}'. If the task has not been completed, retry the last step before interruption and proceed with completing the task.` +
				(responseText
					? `\n\nNew instructions for task continuation:\n<user_message>\n${responseText}\n</user_message>`
					: ""),
		})

		if (responseImages && responseImages.length > 0) {
			newUserContent.push(...this.formatImagesIntoBlocks(responseImages))
		}

		await this.overwriteApiConversationHistory(modifiedApiConversationHistory)
		await this.initiateTaskLoop(newUserContent)
	}

	private async initiateTaskLoop(userContent: UserContent): Promise<void> {
		let nextUserContent = userContent
		let includeFileDetails = true
		while (!this.abort) {
			const didEndLoop = await this.recursivelyMakeClaudeRequests(nextUserContent, includeFileDetails)
			includeFileDetails = false // we only need file details the first time

			//  The way this agentic loop works is that claude will be given a task that he then calls tools to complete. unless there's an attempt_completion call, we keep responding back to him with his tool's responses until he either attempt_completion or does not use anymore tools. If he does not use anymore tools, we ask him to consider if he's completed the task and then call attempt_completion, otherwise proceed with completing the task.
			// There is a MAX_REQUESTS_PER_TASK limit to prevent infinite requests, but Claude is prompted to finish the task as efficiently as he can.

			//const totalCost = this.calculateApiCost(totalInputTokens, totalOutputTokens)
			if (didEndLoop) {
				// For now a task never 'completes'. This will only happen if the user hits max requests and denies resetting the count.
				//this.say("task_completed", `Task completed. Total API usage cost: ${totalCost}`)
				break
			} else {
				// this.say(
				// 	"tool",
				// 	"Claude responded with only text blocks but has not called attempt_completion yet. Forcing him to continue with task..."
				// )
				nextUserContent = [
					{
						type: "text",
						text: "If you have completed the user's task, use the attempt_completion tool. If you require additional information from the user, use the ask_followup_question tool. Otherwise, if you have not completed the task and do not need additional information, then proceed with the next step of the task. (This is an automated message, so do not respond to it conversationally.)",
					},
				]
				this.consecutiveMistakeCount++
			}
		}
	}

	abortTask() {
		this.abort = true // will stop any autonomously running promises
		this.terminalManager.disposeAll()
		this.urlContentFetcher.closeBrowser()
	}

	async executeTool(toolName: ToolName, toolInput: any): Promise<[boolean, ToolResponse]> {
		switch (toolName) {
			case "write_to_file":
				return this.writeToFile(toolInput.path, toolInput.content)
			case "read_file":
				return this.readFile(toolInput.path)
			case "list_files":
				return this.listFiles(toolInput.path, toolInput.recursive)
			case "list_code_definition_names":
				return this.listCodeDefinitionNames(toolInput.path)
			case "search_files":
				return this.searchFiles(toolInput.path, toolInput.regex, toolInput.filePattern)
			case "execute_command":
				return this.executeCommand(toolInput.command)
			case "inspect_site":
				return this.inspectSite(toolInput.url)
			case "ask_followup_question":
				return this.askFollowupQuestion(toolInput.question)
			case "attempt_completion":
				return this.attemptCompletion(toolInput.result, toolInput.command)
			default:
				return [false, `Unknown tool: ${toolName}`]
		}
	}

	calculateApiCost(
		inputTokens: number,
		outputTokens: number,
		cacheCreationInputTokens?: number,
		cacheReadInputTokens?: number
	): number {
		const modelCacheWritesPrice = this.api.getModel().info.cacheWritesPrice
		let cacheWritesCost = 0
		if (cacheCreationInputTokens && modelCacheWritesPrice) {
			cacheWritesCost = (modelCacheWritesPrice / 1_000_000) * cacheCreationInputTokens
		}
		const modelCacheReadsPrice = this.api.getModel().info.cacheReadsPrice
		let cacheReadsCost = 0
		if (cacheReadInputTokens && modelCacheReadsPrice) {
			cacheReadsCost = (modelCacheReadsPrice / 1_000_000) * cacheReadInputTokens
		}
		const baseInputCost = (this.api.getModel().info.inputPrice / 1_000_000) * inputTokens
		const outputCost = (this.api.getModel().info.outputPrice / 1_000_000) * outputTokens
		const totalCost = cacheWritesCost + cacheReadsCost + baseInputCost + outputCost
		return totalCost
	}

	// return is [didUserRejectTool, ToolResponse]
	async writeToFile(relPath?: string, newContent?: string): Promise<[boolean, ToolResponse]> {
		if (relPath === undefined) {
			this.consecutiveMistakeCount++
			return [false, await this.sayAndCreateMissingParamError("write_to_file", "path")]
		}
		if (newContent === undefined) {
			this.consecutiveMistakeCount++
			// Custom error message for this particular case
			await this.say(
				"error",
				`Claude tried to use write_to_file for '${relPath.toPosix()}' without value for required parameter 'content'. This is likely due to reaching the maximum output token limit. Retrying with suggestion to change response size...`
			)
			return [
				false,
				await this.formatToolError(
					`Missing value for required parameter 'content'. This may occur if the file is too large, exceeding output limits. Consider splitting into smaller files or reducing content size. Please retry with all required parameters.`
				),
			]
		}
		this.consecutiveMistakeCount = 0
		try {
			const absolutePath = path.resolve(cwd, relPath)
			const fileExists = await fs
				.access(absolutePath)
				.then(() => true)
				.catch(() => false)

			// if the file is already open, ensure it's not dirty before getting its contents
			if (fileExists) {
				const existingDocument = vscode.workspace.textDocuments.find((doc) =>
					arePathsEqual(doc.uri.fsPath, absolutePath)
				)
				if (existingDocument && existingDocument.isDirty) {
					await existingDocument.save()
				}
			}

			// get diagnostics before editing the file, we'll compare to diagnostics after editing to see if claude needs to fix anything
			const preDiagnostics = vscode.languages.getDiagnostics()

			let originalContent: string
			if (fileExists) {
				originalContent = await fs.readFile(absolutePath, "utf-8")
				// fix issue where claude always removes newline from the file
				const eol = originalContent.includes("\r\n") ? "\r\n" : "\n"
				if (originalContent.endsWith(eol) && !newContent.endsWith(eol)) {
					newContent += eol
				}
			} else {
				originalContent = ""
			}

			const fileName = path.basename(absolutePath)

			// for new files, create any necessary directories and keep track of new directories to delete if the user denies the operation

			// Keep track of newly created directories
			const createdDirs: string[] = await this.createDirectoriesForFile(absolutePath)
			// console.log(`Created directories: ${createdDirs.join(", ")}`)
			// make sure the file exists before we open it
			if (!fileExists) {
				await fs.writeFile(absolutePath, "")
			}

			// Open the existing file with the new contents
			const updatedDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath))

			// await updatedDocument.save()
			// const edit = new vscode.WorkspaceEdit()
			// const fullRange = new vscode.Range(
			// 	updatedDocument.positionAt(0),
			// 	updatedDocument.positionAt(updatedDocument.getText().length)
			// )
			// edit.replace(updatedDocument.uri, fullRange, newContent)
			// await vscode.workspace.applyEdit(edit)

			// Windows file locking issues can prevent temporary files from being saved or closed properly.
			// To avoid these problems, we use in-memory TextDocument objects with the `untitled` scheme.
			// This method keeps the document entirely in memory, bypassing the filesystem and ensuring
			// a consistent editing experience across all platforms. This also has the added benefit of not
			// polluting the user's workspace with temporary files.

			// Create an in-memory document for the new content
			// const inMemoryDocumentUri = vscode.Uri.parse(`untitled:${fileName}`) // untitled scheme is necessary to open a file without it being saved to disk
			// const inMemoryDocument = await vscode.workspace.openTextDocument(inMemoryDocumentUri)
			// const edit = new vscode.WorkspaceEdit()
			// edit.insert(inMemoryDocumentUri, new vscode.Position(0, 0), newContent)
			// await vscode.workspace.applyEdit(edit)

			// Show diff
			await vscode.commands.executeCommand(
				"vscode.diff",
				vscode.Uri.parse(`claude-dev-diff:${fileName}`).with({
					query: Buffer.from(originalContent).toString("base64"),
				}),
				updatedDocument.uri,
				`${fileName}: ${fileExists ? "Original ↔ Claude's Changes" : "New File"} (Editable)`
			)

			// if the file was already open, close it (must happen after showing the diff view since if it's the only tab the column will close)
			let documentWasOpen = false

			// close the tab if it's open
			const tabs = vscode.window.tabGroups.all
				.map((tg) => tg.tabs)
				.flat()
				.filter(
					(tab) =>
						tab.input instanceof vscode.TabInputText && arePathsEqual(tab.input.uri.fsPath, absolutePath)
				)
			for (const tab of tabs) {
				await vscode.window.tabGroups.close(tab)
				// console.log(`Closed tab for ${absolutePath}`)
				documentWasOpen = true
			}

			// console.log(`Document was open: ${documentWasOpen}`)

			// edit needs to happen after we close the original tab
			const edit = new vscode.WorkspaceEdit()
			if (!fileExists) {
				edit.insert(updatedDocument.uri, new vscode.Position(0, 0), newContent)
			} else {
				const fullRange = new vscode.Range(
					updatedDocument.positionAt(0),
					updatedDocument.positionAt(updatedDocument.getText().length)
				)
				edit.replace(updatedDocument.uri, fullRange, newContent)
			}
			// Apply the edit, but without saving so this doesnt trigger a local save in timeline history
			await vscode.workspace.applyEdit(edit) // has the added benefit of maintaing the file's original EOLs

			// Find the first range where the content differs and scroll to it
			if (fileExists) {
				const diffResult = diff.diffLines(originalContent, newContent)
				for (let i = 0, lineCount = 0; i < diffResult.length; i++) {
					const part = diffResult[i]
					if (part.added || part.removed) {
						const startLine = lineCount + 1
						const endLine = lineCount + (part.count || 0)
						const activeEditor = vscode.window.activeTextEditor
						if (activeEditor) {
							try {
								activeEditor.revealRange(
									// + 3 to move the editor up slightly as this looks better
									new vscode.Range(
										new vscode.Position(startLine, 0),
										new vscode.Position(
											Math.min(endLine + 3, activeEditor.document.lineCount - 1),
											0
										)
									),
									vscode.TextEditorRevealType.InCenter
								)
							} catch (error) {
								console.error(`Error revealing range for ${absolutePath}: ${error}`)
							}
						}
						break
					}
					lineCount += part.count || 0
				}
			}

			// remove cursor from the document
			await vscode.commands.executeCommand("workbench.action.focusSideBar")

			let userResponse: {
				response: ClaudeAskResponse
				text?: string
				images?: string[]
			}
			if (fileExists) {
				userResponse = await this.ask(
					"tool",
					JSON.stringify({
						tool: "editedExistingFile",
						path: this.getReadablePath(relPath),
						diff: this.createPrettyPatch(relPath, originalContent, newContent),
					} satisfies ClaudeSayTool)
				)
			} else {
				userResponse = await this.ask(
					"tool",
					JSON.stringify({
						tool: "newFileCreated",
						path: this.getReadablePath(relPath),
						content: newContent,
					} satisfies ClaudeSayTool)
				)
			}
			const { response, text, images } = userResponse

			// const closeInMemoryDocAndDiffViews = async () => {
			// 	// ensure that the in-memory doc is active editor (this seems to fail on windows machines if its already active, so ignoring if there's an error as it's likely it's already active anyways)
			// 	// try {
			// 	// 	await vscode.window.showTextDocument(inMemoryDocument, {
			// 	// 		preview: false, // ensures it opens in non-preview tab (preview tabs are easily replaced)
			// 	// 		preserveFocus: false,
			// 	// 	})
			// 	// 	// await vscode.window.showTextDocument(inMemoryDocument.uri, { preview: true, preserveFocus: false })
			// 	// } catch (error) {
			// 	// 	console.log(`Could not open editor for ${absolutePath}: ${error}`)
			// 	// }
			// 	// await delay(50)
			// 	// // Wait for the in-memory document to become the active editor (sometimes vscode timing issues happen and this would accidentally close claude dev!)
			// 	// await pWaitFor(
			// 	// 	() => {
			// 	// 		return vscode.window.activeTextEditor?.document === inMemoryDocument
			// 	// 	},
			// 	// 	{ timeout: 5000, interval: 50 }
			// 	// )

			// 	// if (vscode.window.activeTextEditor?.document === inMemoryDocument) {
			// 	// 	await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor") // allows us to close the untitled doc without being prompted to save it
			// 	// }

			// 	await this.closeDiffViews()
			// }

			if (response !== "yesButtonTapped") {
				if (!fileExists) {
					if (updatedDocument.isDirty) {
						await updatedDocument.save()
					}
					await this.closeDiffViews()
					await fs.unlink(absolutePath)
					// Remove only the directories we created, in reverse order
					for (let i = createdDirs.length - 1; i >= 0; i--) {
						await fs.rmdir(createdDirs[i])
						console.log(`Directory ${createdDirs[i]} has been deleted.`)
					}
					console.log(`File ${absolutePath} has been deleted.`)
				} else {
					// revert document
					const edit = new vscode.WorkspaceEdit()
					const fullRange = new vscode.Range(
						updatedDocument.positionAt(0),
						updatedDocument.positionAt(updatedDocument.getText().length)
					)
					edit.replace(updatedDocument.uri, fullRange, originalContent)
					// Apply the edit and save, since contents shouldnt have changed this wont show in local history unless of course the user made changes and saved during the edit
					await vscode.workspace.applyEdit(edit)
					await updatedDocument.save()
					console.log(`File ${absolutePath} has been reverted to its original content.`)
					if (documentWasOpen) {
						await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { preview: false })
					}
					await this.closeDiffViews()
				}

				if (response === "messageResponse") {
					await this.say("user_feedback", text, images)
					return [true, this.formatToolResponseWithImages(await this.formatToolDeniedFeedback(text), images)]
				}
				return [true, await this.formatToolDenied()]
			}

			// Save the changes
			const editedContent = updatedDocument.getText()
			if (updatedDocument.isDirty) {
				await updatedDocument.save()
			}
			this.didEditFile = true

			// Read the potentially edited content from the document

			// trigger an entry in the local history for the file
			// if (fileExists) {
			// 	await fs.writeFile(absolutePath, originalContent)
			// 	const editor = await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { preview: false })
			// 	const edit = new vscode.WorkspaceEdit()
			// 	const fullRange = new vscode.Range(
			// 		editor.document.positionAt(0),
			// 		editor.document.positionAt(editor.document.getText().length)
			// 	)
			// 	edit.replace(editor.document.uri, fullRange, editedContent)
			// 	// Apply the edit, this will trigger a local save and timeline history
			// 	await vscode.workspace.applyEdit(edit) // has the added benefit of maintaing the file's original EOLs
			// 	await editor.document.save()
			// }

			// if (!fileExists) {
			// 	await fs.mkdir(path.dirname(absolutePath), { recursive: true })
			// 	await fs.writeFile(absolutePath, "")
			// }
			// await closeInMemoryDocAndDiffViews()

			// await fs.writeFile(absolutePath, editedContent)

			// open file and add text to it, if it fails fallback to using writeFile
			// we try doing it this way since it adds to local history for users to see what's changed in the file's timeline
			// try {
			// 	const editor = await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { preview: false })
			// 	const edit = new vscode.WorkspaceEdit()
			// 	const fullRange = new vscode.Range(
			// 		editor.document.positionAt(0),
			// 		editor.document.positionAt(editor.document.getText().length)
			// 	)
			// 	edit.replace(editor.document.uri, fullRange, editedContent)
			// 	// Apply the edit, this will trigger a local save and timeline history
			// 	await vscode.workspace.applyEdit(edit) // has the added benefit of maintaing the file's original EOLs
			// 	await editor.document.save()
			// } catch (saveError) {
			// 	console.log(`Could not open editor for ${absolutePath}: ${saveError}`)
			// 	await fs.writeFile(absolutePath, editedContent)
			// 	// calling showTextDocument would sometimes fail even though changes were applied, so we'll ignore these one-off errors (likely due to vscode locking issues)
			// 	try {
			// 		await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { preview: false })
			// 	} catch (openFileError) {
			// 		console.log(`Could not open editor for ${absolutePath}: ${openFileError}`)
			// 	}
			// }

			await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { preview: false })

			await this.closeDiffViews()

			/*
			Getting diagnostics before and after the file edit is a better approach than
			automatically tracking problems in real-time. This method ensures we only
			report new problems that are a direct result of this specific edit.
			Since these are new problems resulting from Claude's edit, we know they're
			directly related to the work he's doing. This eliminates the risk of Claude
			going off-task or getting distracted by unrelated issues, which was a problem
			with the previous auto-debug approach. Some users' machines may be slow to
			update diagnostics, so this approach provides a good balance between automation
			and avoiding potential issues where Claude might get stuck in loops due to
			outdated problem information. If no new problems show up by the time the user
			accepts the changes, they can always debug later using the '@problems' mention.
			This way, Claude only becomes aware of new problems resulting from his edits
			and can address them accordingly. If problems don't change immediately after
			applying a fix, Claude won't be notified, which is generally fine since the
			initial fix is usually correct and it may just take time for linters to catch up.
			*/
			const postDiagnostics = vscode.languages.getDiagnostics()
			const newProblems = diagnosticsToProblemsString(
				getNewDiagnostics(preDiagnostics, postDiagnostics),
				[
					vscode.DiagnosticSeverity.Error, // only including errors since warnings can be distracting (if user wants to fix warnings they can use the @problems mention)
				],
				cwd
			) // will be empty string if no errors
			const newProblemsMessage =
				newProblems.length > 0 ? `\n\nNew problems detected after saving the file:\n${newProblems}` : ""
			// await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { preview: false })

			// If the edited content has different EOL characters, we don't want to show a diff with all the EOL differences.
			const newContentEOL = newContent.includes("\r\n") ? "\r\n" : "\n"
			const normalizedEditedContent = editedContent.replace(/\r\n|\n/g, newContentEOL)
			const normalizedNewContent = newContent.replace(/\r\n|\n/g, newContentEOL) // just in case the new content has a mix of varying EOL characters
			if (normalizedEditedContent !== normalizedNewContent) {
				const userDiff = diff.createPatch(relPath.toPosix(), normalizedNewContent, normalizedEditedContent)
				await this.say(
					"user_feedback_diff",
					JSON.stringify({
						tool: fileExists ? "editedExistingFile" : "newFileCreated",
						path: this.getReadablePath(relPath),
						diff: this.createPrettyPatch(relPath, normalizedNewContent, normalizedEditedContent),
					} satisfies ClaudeSayTool)
				)
				return [
					false,
					await this.formatToolResult(
						`The user made the following updates to your content:\n\n${userDiff}\n\nThe updated content, which includes both your original modifications and the user's additional edits, has been successfully saved to ${relPath.toPosix()}. (Note this does not mean you need to re-write the file with the user's changes, as they have already been applied to the file.)${newProblemsMessage}`
					),
				]
			} else {
				return [
					false,
					await this.formatToolResult(
						`The content was successfully saved to ${relPath.toPosix()}.${newProblemsMessage}`
					),
				]
			}
		} catch (error) {
			const errorString = `Error writing file: ${JSON.stringify(serializeError(error))}`
			await this.say(
				"error",
				`Error writing file:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`
			)
			return [false, await this.formatToolError(errorString)]
		}
	}

	/**
	 * Asynchronously creates all non-existing subdirectories for a given file path
	 * and collects them in an array for later deletion.
	 *
	 * @param filePath - The full path to a file.
	 * @returns A promise that resolves to an array of newly created directories.
	 */
	async createDirectoriesForFile(filePath: string): Promise<string[]> {
		const newDirectories: string[] = []
		const normalizedFilePath = path.normalize(filePath) // Normalize path for cross-platform compatibility
		const directoryPath = path.dirname(normalizedFilePath)

		let currentPath = directoryPath
		const dirsToCreate: string[] = []

		// Traverse up the directory tree and collect missing directories
		while (!(await this.exists(currentPath))) {
			dirsToCreate.push(currentPath)
			currentPath = path.dirname(currentPath)
		}

		// Create directories from the topmost missing one down to the target directory
		for (let i = dirsToCreate.length - 1; i >= 0; i--) {
			await fs.mkdir(dirsToCreate[i])
			newDirectories.push(dirsToCreate[i])
		}

		return newDirectories
	}

	/**
	 * Helper function to check if a path exists.
	 *
	 * @param path - The path to check.
	 * @returns A promise that resolves to true if the path exists, false otherwise.
	 */
	async exists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath)
			return true
		} catch {
			return false
		}
	}

	createPrettyPatch(filename = "file", oldStr: string, newStr: string) {
		const patch = diff.createPatch(filename.toPosix(), oldStr, newStr)
		const lines = patch.split("\n")
		const prettyPatchLines = lines.slice(4)
		return prettyPatchLines.join("\n")
	}

	async closeDiffViews() {
		const tabs = vscode.window.tabGroups.all
			.map((tg) => tg.tabs)
			.flat()
			.filter(
				(tab) =>
					tab.input instanceof vscode.TabInputTextDiff && tab.input?.original?.scheme === "claude-dev-diff"
			)

		for (const tab of tabs) {
			// trying to close dirty views results in save popup
			if (!tab.isDirty) {
				await vscode.window.tabGroups.close(tab)
			}
		}
	}

	async readFile(relPath?: string): Promise<[boolean, ToolResponse]> {
		if (relPath === undefined) {
			this.consecutiveMistakeCount++
			return [false, await this.sayAndCreateMissingParamError("read_file", "path")]
		}
		this.consecutiveMistakeCount = 0
		try {
			const absolutePath = path.resolve(cwd, relPath)
			const content = await extractTextFromFile(absolutePath)

			const message = JSON.stringify({
				tool: "readFile",
				path: this.getReadablePath(relPath),
				content: absolutePath,
			} satisfies ClaudeSayTool)
			if (this.alwaysAllowReadOnly) {
				await this.say("tool", message)
			} else {
				const { response, text, images } = await this.ask("tool", message)
				if (response !== "yesButtonTapped") {
					if (response === "messageResponse") {
						await this.say("user_feedback", text, images)
						return [
							true,
							this.formatToolResponseWithImages(await this.formatToolDeniedFeedback(text), images),
						]
					}
					return [true, await this.formatToolDenied()]
				}
			}

			return [false, content]
		} catch (error) {
			const errorString = `Error reading file: ${JSON.stringify(serializeError(error))}`
			await this.say(
				"error",
				`Error reading file:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`
			)
			return [false, await this.formatToolError(errorString)]
		}
	}

	async listFiles(relDirPath?: string, recursiveRaw?: string): Promise<[boolean, ToolResponse]> {
		if (relDirPath === undefined) {
			this.consecutiveMistakeCount++
			return [false, await this.sayAndCreateMissingParamError("list_files", "path")]
		}
		this.consecutiveMistakeCount = 0
		try {
			const recursive = recursiveRaw?.toLowerCase() === "true"
			const absolutePath = path.resolve(cwd, relDirPath)
			const [files, didHitLimit] = await listFiles(absolutePath, recursive, 200)
			const result = this.formatFilesList(absolutePath, files, didHitLimit)

			const message = JSON.stringify({
				tool: recursive ? "listFilesRecursive" : "listFilesTopLevel",
				path: this.getReadablePath(relDirPath),
				content: result,
			} satisfies ClaudeSayTool)
			if (this.alwaysAllowReadOnly) {
				await this.say("tool", message)
			} else {
				const { response, text, images } = await this.ask("tool", message)
				if (response !== "yesButtonTapped") {
					if (response === "messageResponse") {
						await this.say("user_feedback", text, images)
						return [
							true,
							this.formatToolResponseWithImages(await this.formatToolDeniedFeedback(text), images),
						]
					}
					return [true, await this.formatToolDenied()]
				}
			}

			return [false, await this.formatToolResult(result)]
		} catch (error) {
			const errorString = `Error listing files and directories: ${JSON.stringify(serializeError(error))}`
			await this.say(
				"error",
				`Error listing files and directories:\n${
					error.message ?? JSON.stringify(serializeError(error), null, 2)
				}`
			)
			return [false, await this.formatToolError(errorString)]
		}
	}

	getReadablePath(relPath: string): string {
		// path.resolve is flexible in that it will resolve relative paths like '../../' to the cwd and even ignore the cwd if the relPath is actually an absolute path
		const absolutePath = path.resolve(cwd, relPath)
		if (arePathsEqual(cwd, path.join(os.homedir(), "Desktop"))) {
			// User opened vscode without a workspace, so cwd is the Desktop. Show the full absolute path to keep the user aware of where files are being created
			return absolutePath.toPosix()
		}
		if (arePathsEqual(path.normalize(absolutePath), path.normalize(cwd))) {
			return path.basename(absolutePath).toPosix()
		} else {
			// show the relative path to the cwd
			const normalizedRelPath = path.relative(cwd, absolutePath)
			if (absolutePath.includes(cwd)) {
				return normalizedRelPath.toPosix()
			} else {
				// we are outside the cwd, so show the absolute path (useful for when claude passes in '../../' for example)
				return absolutePath.toPosix()
			}
		}
	}

	formatFilesList(absolutePath: string, files: string[], didHitLimit: boolean): string {
		const sorted = files
			.map((file) => {
				// convert absolute path to relative path
				const relativePath = path.relative(absolutePath, file).toPosix()
				return file.endsWith("/") ? relativePath + "/" : relativePath
			})
			// Sort so files are listed under their respective directories to make it clear what files are children of what directories. Since we build file list top down, even if file list is truncated it will show directories that claude can then explore further.
			.sort((a, b) => {
				const aParts = a.split("/") // only works if we use toPosix first
				const bParts = b.split("/")
				for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
					if (aParts[i] !== bParts[i]) {
						// If one is a directory and the other isn't at this level, sort the directory first
						if (i + 1 === aParts.length && i + 1 < bParts.length) {
							return -1
						}
						if (i + 1 === bParts.length && i + 1 < aParts.length) {
							return 1
						}
						// Otherwise, sort alphabetically
						return aParts[i].localeCompare(bParts[i], undefined, { numeric: true, sensitivity: "base" })
					}
				}
				// If all parts are the same up to the length of the shorter path,
				// the shorter one comes first
				return aParts.length - bParts.length
			})
		if (didHitLimit) {
			return `${sorted.join(
				"\n"
			)}\n\n(File list truncated. Use list_files on specific subdirectories if you need to explore further.)`
		} else if (sorted.length === 0 || (sorted.length === 1 && sorted[0] === "")) {
			return "No files found."
		} else {
			return sorted.join("\n")
		}
	}

	async listCodeDefinitionNames(relDirPath?: string): Promise<[boolean, ToolResponse]> {
		if (relDirPath === undefined) {
			this.consecutiveMistakeCount++
			return [false, await this.sayAndCreateMissingParamError("list_code_definition_names", "path")]
		}
		this.consecutiveMistakeCount = 0
		try {
			const absolutePath = path.resolve(cwd, relDirPath)
			const result = await parseSourceCodeForDefinitionsTopLevel(absolutePath)

			const message = JSON.stringify({
				tool: "listCodeDefinitionNames",
				path: this.getReadablePath(relDirPath),
				content: result,
			} satisfies ClaudeSayTool)
			if (this.alwaysAllowReadOnly) {
				await this.say("tool", message)
			} else {
				const { response, text, images } = await this.ask("tool", message)
				if (response !== "yesButtonTapped") {
					if (response === "messageResponse") {
						await this.say("user_feedback", text, images)
						return [
							true,
							this.formatToolResponseWithImages(await this.formatToolDeniedFeedback(text), images),
						]
					}
					return [true, await this.formatToolDenied()]
				}
			}

			return [false, await this.formatToolResult(result)]
		} catch (error) {
			const errorString = `Error parsing source code definitions: ${JSON.stringify(serializeError(error))}`
			await this.say(
				"error",
				`Error parsing source code definitions:\n${
					error.message ?? JSON.stringify(serializeError(error), null, 2)
				}`
			)
			return [false, await this.formatToolError(errorString)]
		}
	}

	async searchFiles(relDirPath: string, regex: string, filePattern?: string): Promise<[boolean, ToolResponse]> {
		if (relDirPath === undefined) {
			this.consecutiveMistakeCount++
			return [false, await this.sayAndCreateMissingParamError("search_files", "path")]
		}
		if (regex === undefined) {
			this.consecutiveMistakeCount++
			return [false, await this.sayAndCreateMissingParamError("search_files", "regex", relDirPath)]
		}
		this.consecutiveMistakeCount = 0
		try {
			const absolutePath = path.resolve(cwd, relDirPath)
			const results = await regexSearchFiles(cwd, absolutePath, regex, filePattern)

			const message = JSON.stringify({
				tool: "searchFiles",
				path: this.getReadablePath(relDirPath),
				regex: regex,
				filePattern: filePattern,
				content: results,
			} satisfies ClaudeSayTool)

			if (this.alwaysAllowReadOnly) {
				await this.say("tool", message)
			} else {
				const { response, text, images } = await this.ask("tool", message)
				if (response !== "yesButtonTapped") {
					if (response === "messageResponse") {
						await this.say("user_feedback", text, images)
						return [
							true,
							this.formatToolResponseWithImages(await this.formatToolDeniedFeedback(text), images),
						]
					}
					return [true, await this.formatToolDenied()]
				}
			}

			return [false, await this.formatToolResult(results)]
		} catch (error) {
			const errorString = `Error searching files: ${JSON.stringify(serializeError(error))}`
			await this.say(
				"error",
				`Error searching files:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`
			)
			return [false, await this.formatToolError(errorString)]
		}
	}

	async inspectSite(url?: string): Promise<[boolean, ToolResponse]> {
		if (url === undefined) {
			this.consecutiveMistakeCount++
			return [false, await this.sayAndCreateMissingParamError("inspect_site", "url")]
		}
		this.consecutiveMistakeCount = 0
		try {
			const message = JSON.stringify({
				tool: "inspectSite",
				path: url,
			} satisfies ClaudeSayTool)

			if (this.alwaysAllowReadOnly) {
				await this.say("tool", message)
			} else {
				const { response, text, images } = await this.ask("tool", message)
				if (response !== "yesButtonTapped") {
					if (response === "messageResponse") {
						await this.say("user_feedback", text, images)
						return [
							true,
							this.formatToolResponseWithImages(await this.formatToolDeniedFeedback(text), images),
						]
					}
					return [true, await this.formatToolDenied()]
				}
			}

			await this.say("inspect_site_result", "") // no result, starts the loading spinner waiting for result
			await this.urlContentFetcher.launchBrowser()
			let result: {
				screenshot: string
				logs: string
			}
			try {
				result = await this.urlContentFetcher.urlToScreenshotAndLogs(url)
			} finally {
				await this.urlContentFetcher.closeBrowser()
			}
			const { screenshot, logs } = result
			await this.say("inspect_site_result", logs, [screenshot])

			return [
				false,
				this.formatToolResponseWithImages(
					`The site has been visited, with console logs captured and a screenshot taken for your analysis.\n\nConsole logs:\n${
						logs || "(No logs)"
					}`,
					[screenshot]
				),
			]
		} catch (error) {
			const errorString = `Error inspecting site: ${JSON.stringify(serializeError(error))}`
			await this.say(
				"error",
				`Error inspecting site:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`
			)
			return [false, await this.formatToolError(errorString)]
		}
	}

	async executeCommandTool(
		command: string,
		returnEmptyStringOnSuccess: boolean = false
	): Promise<[boolean, ToolResponse]> {
		const terminalInfo = await this.terminalManager.getOrCreateTerminal(cwd)
		terminalInfo.terminal.show() // weird visual bug when creating new terminals (even manually) where there's an empty space at the top.
		const process = this.terminalManager.runCommand(terminalInfo, command)

		let userFeedback: { text?: string; images?: string[] } | undefined
		let didContinue = false
		const sendCommandOutput = async (line: string): Promise<void> => {
			try {
				const { response, text, images } = await this.ask("command_output", line)
				if (response === "yesButtonTapped") {
					// proceed while running
				} else {
					userFeedback = { text, images }
				}
				didContinue = true
				process.continue() // continue past the await
			} catch {
				// This can only happen if this ask promise was ignored, so ignore this error
			}
		}

		let result = ""
		process.on("line", (line) => {
			result += line + "\n"
			if (!didContinue) {
				sendCommandOutput(line)
			} else {
				this.say("command_output", line)
			}
		})

		let completed = false
		process.once("completed", () => {
			completed = true
		})

		process.once("no_shell_integration", async () => {
			await this.say("shell_integration_warning")
		})

		await process

		// Wait for a short delay to ensure all messages are sent to the webview
		// This delay allows time for non-awaited promises to be created and
		// for their associated messages to be sent to the webview, maintaining
		// the correct order of messages (although the webview is smart about
		// grouping command_output messages despite any gaps anyways)
		await delay(50)

		result = result.trim()

		if (userFeedback) {
			await this.say("user_feedback", userFeedback.text, userFeedback.images)
			return [
				true,
				this.formatToolResponseWithImages(
					`Command is still running in the user's terminal.${
						result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
					}\n\nThe user provided the following feedback:\n<feedback>\n${userFeedback.text}\n</feedback>`,
					userFeedback.images
				),
			]
		}

		// for attemptCompletion, we don't want to return the command output
		if (returnEmptyStringOnSuccess) {
			return [false, ""]
		}
		if (completed) {
			return [
				false,
				await this.formatToolResult(`Command executed.${result.length > 0 ? `\nOutput:\n${result}` : ""}`),
			]
		} else {
			return [
				false,
				await this.formatToolResult(
					`Command is still running in the user's terminal.${
						result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
					}\n\nYou will be updated on the terminal status and new output in the future.`
				),
			]
		}
	}

	async executeCommand(
		command?: string,
		returnEmptyStringOnSuccess: boolean = false
	): Promise<[boolean, ToolResponse]> {
		if (command === undefined) {
			this.consecutiveMistakeCount++
			return [false, await this.sayAndCreateMissingParamError("execute_command", "command")]
		}
		this.consecutiveMistakeCount = 0
		const { response, text, images } = await this.ask("command", command)
		if (response !== "yesButtonTapped") {
			if (response === "messageResponse") {
				await this.say("user_feedback", text, images)
				return [true, this.formatToolResponseWithImages(await this.formatToolDeniedFeedback(text), images)]
			}
			return [true, await this.formatToolDenied()]
		}

		try {
			const terminalInfo = await this.terminalManager.getOrCreateTerminal(cwd)
			terminalInfo.terminal.show() // weird visual bug when creating new terminals (even manually) where there's an empty space at the top.
			const process = this.terminalManager.runCommand(terminalInfo, command)

			let userFeedback: { text?: string; images?: string[] } | undefined
			let didContinue = false
			const sendCommandOutput = async (line: string): Promise<void> => {
				try {
					const { response, text, images } = await this.ask("command_output", line)
					if (response === "yesButtonTapped") {
						// proceed while running
					} else {
						userFeedback = { text, images }
					}
					didContinue = true
					process.continue() // continue past the await
				} catch {
					// This can only happen if this ask promise was ignored, so ignore this error
				}
			}

			let result = ""
			process.on("line", (line) => {
				result += line + "\n"
				if (!didContinue) {
					sendCommandOutput(line)
				} else {
					this.say("command_output", line)
				}
			})

			let completed = false
			process.once("completed", () => {
				completed = true
			})

			process.once("no_shell_integration", async () => {
				await this.say("shell_integration_warning")
			})

			await process

			// Wait for a short delay to ensure all messages are sent to the webview
			// This delay allows time for non-awaited promises to be created and
			// for their associated messages to be sent to the webview, maintaining
			// the correct order of messages (although the webview is smart about
			// grouping command_output messages despite any gaps anyways)
			await delay(50)

			result = result.trim()

			if (userFeedback) {
				await this.say("user_feedback", userFeedback.text, userFeedback.images)
				return [
					true,
					this.formatToolResponseWithImages(
						`Command is still running in the user's terminal.${
							result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
						}\n\nThe user provided the following feedback:\n<feedback>\n${userFeedback.text}\n</feedback>`,
						userFeedback.images
					),
				]
			}

			// for attemptCompletion, we don't want to return the command output
			if (returnEmptyStringOnSuccess) {
				return [false, ""]
			}
			if (completed) {
				return [
					false,
					await this.formatToolResult(`Command executed.${result.length > 0 ? `\nOutput:\n${result}` : ""}`),
				]
			} else {
				return [
					false,
					await this.formatToolResult(
						`Command is still running in the user's terminal.${
							result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
						}\n\nYou will be updated on the terminal status and new output in the future.`
					),
				]
			}
		} catch (error) {
			let errorMessage = error.message || JSON.stringify(serializeError(error), null, 2)
			const errorString = `Error executing command:\n${errorMessage}`
			await this.say("error", `Error executing command:\n${errorMessage}`)
			return [false, await this.formatToolError(errorString)]
		}
	}

	async askFollowupQuestion(question?: string): Promise<[boolean, ToolResponse]> {
		if (question === undefined) {
			this.consecutiveMistakeCount++
			return [false, await this.sayAndCreateMissingParamError("ask_followup_question", "question")]
		}
		this.consecutiveMistakeCount = 0
		const { text, images } = await this.ask("followup", question)
		await this.say("user_feedback", text ?? "", images)
		return [false, this.formatToolResponseWithImages(`<answer>\n${text}\n</answer>`, images)]
	}

	async attemptCompletion(result?: string, command?: string): Promise<[boolean, ToolResponse]> {
		// result is required, command is optional
		if (result === undefined) {
			this.consecutiveMistakeCount++
			return [false, await this.sayAndCreateMissingParamError("attempt_completion", "result")]
		}
		this.consecutiveMistakeCount = 0
		let resultToSend = result
		if (command) {
			await this.say("completion_result", resultToSend)
			// TODO: currently we don't handle if this command fails, it could be useful to let claude know and retry
			const [didUserReject, commandResult] = await this.executeCommand(command, true)
			// if we received non-empty string, the command was rejected or failed
			if (commandResult) {
				return [didUserReject, commandResult]
			}
			resultToSend = ""
		}
		const { response, text, images } = await this.ask("completion_result", resultToSend) // this prompts webview to show 'new task' button, and enable text input (which would be the 'text' here)
		if (response === "yesButtonTapped") {
			return [false, ""] // signals to recursive loop to stop (for now this never happens since yesButtonTapped will trigger a new task)
		}
		await this.say("user_feedback", text ?? "", images)
		return [
			true,
			this.formatToolResponseWithImages(
				`The user has provided feedback on the results. Consider their input to continue the task, and then attempt completion again.\n<feedback>\n${text}\n</feedback>`,
				images
			),
		]
	}

	async attemptApiRequest(): Promise<AnthropicStream> {
		try {
			let systemPrompt = await SYSTEM_PROMPT(cwd, this.api.getModel().info.supportsImages)
			if (this.customInstructions && this.customInstructions.trim()) {
				// altering the system prompt mid-task will break the prompt cache, but in the grand scheme this will not change often so it's better to not pollute user messages with it the way we have to with <potentially relevant details>
				systemPrompt += `
====

USER'S CUSTOM INSTRUCTIONS

The following additional instructions are provided by the user. They should be followed and given precedence in case of conflicts with previous instructions.

${this.customInstructions.trim()}
`
			}

			// If the last API request's total token usage is close to the context window, truncate the conversation history to free up space for the new request
			const lastApiReqFinished = findLast(this.claudeMessages, (m) => m.say === "api_req_finished")
			if (lastApiReqFinished && lastApiReqFinished.text) {
				const {
					tokensIn,
					tokensOut,
					cacheWrites,
					cacheReads,
				}: { tokensIn?: number; tokensOut?: number; cacheWrites?: number; cacheReads?: number } = JSON.parse(
					lastApiReqFinished.text
				)
				const totalTokens = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
				const contextWindow = this.api.getModel().info.contextWindow
				const maxAllowedSize = Math.max(contextWindow - 40_000, contextWindow * 0.8)
				if (totalTokens >= maxAllowedSize) {
					const truncatedMessages = truncateHalfConversation(this.apiConversationHistory)
					await this.overwriteApiConversationHistory(truncatedMessages)
				}
			}
			const stream = await this.api.createMessage(
				systemPrompt,
				this.apiConversationHistory,
				TOOLS(cwd, this.api.getModel().info.supportsImages)
			)
			return stream
		} catch (error) {
			const { response } = await this.ask(
				"api_req_failed",
				error.message ?? JSON.stringify(serializeError(error), null, 2)
			)
			if (response !== "yesButtonTapped") {
				// this will never happen since if noButtonTapped, we will clear current task, aborting this instance
				throw new Error("API request failed")
			}
			await this.say("api_req_retried")
			return this.attemptApiRequest()
		}
	}

	async presentAssistantMessage() {
		if (this.presentAssistantMessageLocked) {
			this.presentAssistantMessageHasPendingUpdates = true
			return
		}
		this.presentAssistantMessageLocked = true
		this.presentAssistantMessageHasPendingUpdates = false

		if (this.currentStreamingContentIndex >= this.assistantMessageContent.length) {
			throw new Error("No more content blocks to stream! This shouldn't happen...") // remove and just return after testing
		}

		const block = cloneDeep(this.assistantMessageContent[this.currentStreamingContentIndex]) // need to create copy bc while stream is updating the array, it could be updating the reference block properties too
		switch (block.type) {
			case "text":
				await this.say("text", block.content, undefined, block.partial)
				break
			case "tool_call":
				const toolDescription = () => {
					switch (block.name) {
						case "execute_command":
							return `[${block.name} for '${block.params.command}']`
						case "read_file":
							return `[${block.name} for '${block.params.path}']`
						case "write_to_file":
							return `[${block.name} for '${block.params.path}']`
						case "search_files":
							return `[${block.name} for '${block.params.regex}'${
								block.params.file_pattern ? ` in '${block.params.file_pattern}'` : ""
							}]`
						case "list_files":
							return `[${block.name} for '${block.params.path}']`
						case "list_code_definition_names":
							return `[${block.name} for '${block.params.path}']`
						case "inspect_site":
							return `[${block.name} for '${block.params.url}']`
						case "ask_followup_question":
							return `[${block.name} for '${block.params.question}']`
						case "attempt_completion":
							return `[${block.name}]`
					}
				}

				if (this.didRejectTool) {
					// ignore any tool content after user has rejected tool once
					// we'll fill it in with a rejection message when the message is complete
					if (!block.partial) {
						this.userMessageContent.push({
							type: "text",
							text: `Skipping tool ${toolDescription()} due to user rejecting a previous tool.`,
						})
					}
					break
				}

				const pushToolResult = (content: ToolResponse) => {
					this.userMessageContent.push({
						type: "text",
						text: `${toolDescription()} Result:`,
					})
					if (typeof content === "string") {
						this.userMessageContent.push({
							type: "text",
							text: content,
						})
					} else {
						this.userMessageContent.push(...content)
					}
				}

				const askApproval = async (type: ClaudeAsk, partialMessage?: string) => {
					const { response, text, images } = await this.ask(type, partialMessage, false)
					if (response !== "yesButtonTapped") {
						if (response === "messageResponse") {
							await this.say("user_feedback", text, images)
							pushToolResult(
								this.formatToolResponseWithImages(await this.formatToolDeniedFeedback(text), images)
							)
							// this.userMessageContent.push({
							// 	type: "text",
							// 	text: `${toolDescription()}`,
							// })
							// this.toolResults.push({
							// 	type: "tool_result",
							// 	tool_use_id: toolUseId,
							// 	content: this.formatToolResponseWithImages(
							// 		await this.formatToolDeniedFeedback(text),
							// 		images
							// 	),
							// })
							this.didRejectTool = true
							return false
						}
						pushToolResult(await this.formatToolDenied())
						// this.toolResults.push({
						// 	type: "tool_result",
						// 	tool_use_id: toolUseId,
						// 	content: await this.formatToolDenied(),
						// })
						this.didRejectTool = true
						return false
					}
					return true
				}

				const handleError = async (action: string, error: Error) => {
					const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`
					await this.say(
						"error",
						`Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`
					)
					// this.toolResults.push({
					// 	type: "tool_result",
					// 	tool_use_id: toolUseId,
					// 	content: await this.formatToolError(errorString),
					// })
					pushToolResult(await this.formatToolError(errorString))
				}

				switch (block.name) {
					case "read_file": {
						const relPath: string | undefined = block.params.path
						const sharedMessageProps: ClaudeSayTool = {
							tool: "readFile",
							path: relPath || "", //this.getReadablePath(relPath || ""),
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: undefined,
								} satisfies ClaudeSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", partialMessage, undefined, block.partial)
								} else {
									await this.ask("tool", partialMessage, block.partial).catch(() => {})
								}
								break
							} else {
								if (!relPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("read_file", "path"))
									break
								}
								this.consecutiveMistakeCount = 0
								const absolutePath = path.resolve(cwd, relPath)
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: absolutePath,
								} satisfies ClaudeSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", completeMessage, undefined, false) // need to be sending partialValue bool, since undefined has its own purpose in that the message is treated neither as a partial or completion of a partial, but as a single complete message
								} else {
									const didApprove = await askApproval("tool", completeMessage)
									if (!didApprove) {
										break
									}
								}
								// now execute the tool like normal
								const content = await extractTextFromFile(absolutePath)
								pushToolResult(content)
								break
							}
						} catch (error) {
							await handleError("reading file", error)
							break
						}
					}
					case "list_files": {
						const relDirPath: string | undefined = block.params.path
						const recursiveRaw: string | undefined = block.params.path
						const recursive = recursiveRaw?.toLowerCase() === "true"
						const sharedMessageProps: ClaudeSayTool = {
							tool: !recursive ? "listFilesTopLevel" : "listFilesRecursive",
							path: relDirPath || "",
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: "",
								} satisfies ClaudeSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", partialMessage, undefined, block.partial)
								} else {
									await this.ask("tool", partialMessage, block.partial).catch(() => {})
								}
								break
							} else {
								if (!relDirPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("list_files", "path"))
									break
								}
								this.consecutiveMistakeCount = 0
								const absolutePath = path.resolve(cwd, relDirPath)
								const [files, didHitLimit] = await listFiles(absolutePath, recursive, 200)
								const result = this.formatFilesList(absolutePath, files, didHitLimit)
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: result,
								} satisfies ClaudeSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", completeMessage, undefined, false)
								} else {
									const didApprove = await askApproval("tool", completeMessage)
									if (!didApprove) {
										break
									}
								}
								pushToolResult(result)
								break
							}
						} catch (error) {
							await handleError("reading file", error)
							break
						}
					}
					case "list_code_definition_names": {
						const relDirPath: string | undefined = block.params.path
						const sharedMessageProps: ClaudeSayTool = {
							tool: "listCodeDefinitionNames",
							path: relDirPath || "",
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: "",
								} satisfies ClaudeSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", partialMessage, undefined, block.partial)
								} else {
									await this.ask("tool", partialMessage, block.partial).catch(() => {})
								}
								break
							} else {
								if (!relDirPath) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("list_code_definition_names", "path")
									)
									break
								}
								this.consecutiveMistakeCount = 0
								const absolutePath = path.resolve(cwd, relDirPath)
								const result = await parseSourceCodeForDefinitionsTopLevel(absolutePath)
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: result,
								} satisfies ClaudeSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", completeMessage, undefined, false)
								} else {
									const didApprove = await askApproval("tool", completeMessage)
									if (!didApprove) {
										break
									}
								}
								pushToolResult(result)
								break
							}
						} catch (error) {
							await handleError("parsing source code definitions", error)
							break
						}
					}
					case "search_files": {
						const relDirPath: string | undefined = block.params.path
						const regex: string | undefined = block.params.regex
						const filePattern: string | undefined = block.params.file_pattern
						const sharedMessageProps: ClaudeSayTool = {
							tool: "searchFiles",
							path: relDirPath || "",
							regex: regex || "",
							filePattern: filePattern || "",
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: "",
								} satisfies ClaudeSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", partialMessage, undefined, block.partial)
								} else {
									await this.ask("tool", partialMessage, block.partial).catch(() => {})
								}
								break
							} else {
								if (!relDirPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("search_files", "path"))
									break
								}
								if (!regex) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("search_files", "regex"))
									break
								}
								this.consecutiveMistakeCount = 0
								const absolutePath = path.resolve(cwd, relDirPath)
								const results = await regexSearchFiles(cwd, absolutePath, regex, filePattern)
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: results,
								} satisfies ClaudeSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", completeMessage, undefined, false)
								} else {
									const didApprove = await askApproval("tool", completeMessage)
									if (!didApprove) {
										break
									}
								}
								pushToolResult(results)
								break
							}
						} catch (error) {
							await handleError("searching files", error)
							break
						}
					}
					case "inspect_site": {
						const url: string | undefined = block.params.url
						const sharedMessageProps: ClaudeSayTool = {
							tool: "inspectSite",
							path: url || "",
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify(sharedMessageProps)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", partialMessage, undefined, block.partial)
								} else {
									await this.ask("tool", partialMessage, block.partial).catch(() => {})
								}
								break
							} else {
								if (!url) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("inspect_site", "url"))
									break
								}
								this.consecutiveMistakeCount = 0
								const completeMessage = JSON.stringify(sharedMessageProps)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", completeMessage, undefined, false)
								} else {
									const didApprove = await askApproval("tool", completeMessage)
									if (!didApprove) {
										break
									}
								}

								// execute tool
								await this.say("inspect_site_result", "") // no result, starts the loading spinner waiting for result
								await this.urlContentFetcher.launchBrowser()
								let result: {
									screenshot: string
									logs: string
								}
								try {
									result = await this.urlContentFetcher.urlToScreenshotAndLogs(url)
								} finally {
									await this.urlContentFetcher.closeBrowser()
								}
								const { screenshot, logs } = result
								await this.say("inspect_site_result", logs, [screenshot])

								pushToolResult(
									this.formatToolResponseWithImages(
										`The site has been visited, with console logs captured and a screenshot taken for your analysis.\n\nConsole logs:\n${
											logs || "(No logs)"
										}`,
										[screenshot]
									)
								)
								break
							}
						} catch (error) {
							await handleError("inspecting site", error)
							break
						}
					}
					case "execute_command": {
						const command: string | undefined = block.params.command
						try {
							if (block.partial) {
								await this.ask("command", command || "", block.partial).catch(() => {})
								break
							} else {
								if (!command) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("execute_command", "command")
									)
									break
								}
								this.consecutiveMistakeCount = 0
								const didApprove = await askApproval("command", command)
								if (!didApprove) {
									break
								}
								const [userRejected, result] = await this.executeCommandTool(command)
								if (userRejected) {
									this.didRejectTool = true // test whats going on here
								}
								pushToolResult(result)
								break
							}
						} catch (error) {
							await handleError("inspecting site", error)
							break
						}
					}

					case "ask_followup_question": {
						const question: string | undefined = block.params.question
						try {
							if (block.partial) {
								await this.ask("followup", question || "", block.partial).catch(() => {})
								break
							} else {
								if (!question) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("ask_followup_question", "question")
									)
									break
								}
								this.consecutiveMistakeCount = 0
								const { text, images } = await this.ask("followup", question, false)
								await this.say("user_feedback", text ?? "", images)
								pushToolResult(
									this.formatToolResponseWithImages(`<answer>\n${text}\n</answer>`, images)
								)
								break
							}
						} catch (error) {
							await handleError("inspecting site", error)
							break
						}
					}
					case "attempt_completion": {
						const result: string | undefined = block.params.result
						const command: string | undefined = block.params.command
						try {
							const lastMessage = this.claudeMessages.at(-1)
							if (block.partial) {
								if (command) {
									// the attempt_completion text is done, now we're getting command
									// remove the previous partial attempt_completion ask, replace with say, post state to webview, then stream command

									// const secondLastMessage = this.claudeMessages.at(-2)
									if (lastMessage && lastMessage.ask === "command") {
										// update command
										await this.ask("command", command || "", block.partial).catch(() => {})
									} else {
										// last message is completion_result
										// we have command string, but last message is attempt_completion, so finish it
										await this.say("completion_result", result, undefined, false)
										await this.ask("command", command || "", block.partial).catch(() => {})
									}
								} else {
									// no command, still outputting partial result
									await this.say("completion_result", result || "", undefined, block.partial)
								}
								break
							} else {
								if (!result) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("attempt_completion", "result")
									)
									break
								}
								this.consecutiveMistakeCount = 0
								if (lastMessage && lastMessage.ask === "command") {
									// complete command message
									const didApprove = await askApproval("command", command)
									if (!didApprove) {
										break
									}
									const [userRejected, result] = await this.executeCommandTool(command!)
									if (userRejected) {
										this.didRejectTool = true // test whats going on here
									}
									pushToolResult(result)
									break
								} else {
									// last message is completion_result, not command so it wasn't completed, need to complete it
									// empty string makes it invisible and just shows new task button
									const { response, text, images } = await this.ask("completion_result", "", false)
									if (response === "yesButtonTapped") {
										pushToolResult("") // signals to recursive loop to stop (for now this never happens since yesButtonTapped will trigger a new task)
										break
									}
									await this.say("user_feedback", text ?? "", images)
									pushToolResult(
										this.formatToolResponseWithImages(
											`The user has provided feedback on the results. Consider their input to continue the task, and then attempt completion again.\n<feedback>\n${text}\n</feedback>`,
											images
										)
									)
									break
								}
							}
						} catch (error) {
							await handleError("inspecting site", error)
							break
						}
					}

					// case "write_to_file":
					// 	return this.writeToFile(toolInput.path, toolInput.content)

					// default:
					// 	return [false, `Unknown tool: ${toolName}`]
				}

				break
		}

		this.presentAssistantMessageLocked = false
		if (!block.partial) {
			// block is finished streaming and executing
			if (
				this.currentStreamingContentIndex === this.assistantMessageContent.length - 1 &&
				this.didCompleteReadingStream
			) {
				// last block is complete and it is finished executing
				this.userMessageContentReady = true // will allow pwaitfor to continue
			} else {
				// call next block if it exists (if not then read stream will call it when its ready)
				this.currentStreamingContentIndex++ // need to increment regardless, so when read stream calls this function again it will be streaming the next block
				if (this.currentStreamingContentIndex < this.assistantMessageContent.length) {
					// there are already more content blocks to stream, so we'll call this function ourselves
					// await this.presentAssistantContent()
					this.presentAssistantMessage()
					return
				}
			}
		}
		// block is partial, but the read stream may have finished
		if (this.presentAssistantMessageHasPendingUpdates) {
			this.presentAssistantMessage()
		}
	}

	// //
	// private partialJsonParser: JSONParser | undefined
	// private partialJsonParserState: {
	// 	partialObject: Record<string, string>
	// 	currentKey: string
	// 	currentValue: string
	// 	parsingKey: boolean
	// 	parsingValue: boolean
	// } = {
	// 	partialObject: {},
	// 	currentKey: "",
	// 	currentValue: "",
	// 	parsingKey: false,
	// 	parsingValue: false,
	// }
	// private chunkIndexToJsonParser = new Map<number, JSONParser>()
	// getJsonParserForChunk(chunkIndex: number): JSONParser {
	// 	if (!this.chunkIndexToJsonParser.has(chunkIndex)) {
	// 		const parser = new JSONParser({ emitPartialTokens: true, emitPartialValues: true })
	// 		// this package enforces setting up an onValue listener ("Can't emit data before the "onValue" callback has been set up."), even though we don't need it.
	// 		parser.onValue = () => console.log(`onValue for chunk ${chunkIndex}`)
	// 		// parser.onError = (error) => console.error(`Error parsing JSON for chunk ${chunkIndex}:`, error);
	// 		// parser.onEnd = () => console.log(`JSON parsing ended for chunk ${chunkIndex}`);

	// 		let partialObject: Record<string, string> = {}
	// 		let currentKey: string = ""
	// 		let currentValue: string = ""
	// 		let parsingKey: boolean = false
	// 		let parsingValue: boolean = false

	// 		// our json will only ever be string to string maps
	// 		// { "key": "value", "key2": "value2" }
	// 		// so left brace, string, colon, comma, right brace
	// 		// (need to recreate this listener each time to update the resolve ref)
	// 		parser.onToken = ({ token, value, offset, partial }) => {
	// 			console.log("onToken")

	// 			try {
	// 				switch (token) {
	// 					case TokenType.LEFT_BRACE:
	// 						// Start of a new JSON object
	// 						partialObject = {}
	// 						currentKey = ""
	// 						parsingKey = false
	// 						parsingValue = false
	// 						break
	// 					case TokenType.RIGHT_BRACE:
	// 						// End of the current JSON object
	// 						currentKey = ""
	// 						currentValue = ""
	// 						parsingKey = false
	// 						parsingValue = false

	// 						// Finalize the object once parsing is complete
	// 						// ;(this.assistantContentBlocks[chunkIndex] as Anthropic.ToolUseBlock).input = this.partialObject
	// 						// this.assistantContentBlocks[chunkIndex]!.partial = false
	// 						// await this.presentAssistantContent() // NOTE: only set partial = false and call this once, since doing it several times will create duplicate messages.
	// 						console.log("Final parsed object:", partialObject)
	// 						break
	// 					case TokenType.STRING:
	// 						if (!parsingValue && !parsingKey) {
	// 							// Starting to parse a key
	// 							currentKey = value as string
	// 							parsingKey = !!partial // if not partial, we are done parsing key
	// 						} else if (parsingKey) {
	// 							// Continuing to parse a key
	// 							currentKey = value as string
	// 							parsingKey = !!partial
	// 						} else if (parsingValue) {
	// 							// Parsing a value
	// 							// Accumulate partial value and update the object
	// 							currentValue = value as string
	// 							if (currentKey) {
	// 								partialObject[currentKey] = currentValue
	// 							}
	// 							parsingValue = !!partial // if not partial, complete value
	// 						}
	// 						break
	// 					case TokenType.COLON:
	// 						// After a key and colon, expect a value
	// 						if (currentKey !== null) {
	// 							parsingValue = true
	// 						}
	// 						break
	// 					case TokenType.COMMA:
	// 						// Reset for the next key-value pair
	// 						currentKey = ""
	// 						currentValue = ""
	// 						parsingKey = false
	// 						parsingValue = false
	// 						break
	// 					default:
	// 						console.error("Unexpected token:", token)
	// 				}

	// 				// Debugging logs to trace the parsing process
	// 				console.log("Partial object:", partialObject)
	// 				console.log("Offset:", offset, "isPartialToken:", partial)

	// 				// Update the contentBlock with the current state of the partial object
	// 				// Use spread operator to ensure a new object reference
	// 				;(this.assistantContentBlocks[chunkIndex] as Anthropic.ToolUseBlock).input = {
	// 					...partialObject,
	// 				}
	// 				// right brace indicates the end of the json object
	// 				this.assistantContentBlocks[chunkIndex]!.partial = token !== TokenType.RIGHT_BRACE

	// 				this.presentAssistantContent()
	// 			} catch (error) {
	// 				console.error("Error parsing input_json_delta", error)
	// 			}
	// 		}

	// 		this.chunkIndexToJsonParser.set(chunkIndex, parser)
	// 	}
	// 	return this.chunkIndexToJsonParser.get(chunkIndex)!
	// }

	// streaming
	private currentStreamingContentIndex = 0
	private assistantMessageContent: AssistantMessageContent[] = []
	private didCompleteReadingStream = false
	// private assistantMessage?: AssistantMessage
	private userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
	private userMessageContentReady = false
	private didRejectTool = false
	private presentAssistantMessageLocked = false
	private presentAssistantMessageHasPendingUpdates = false

	private parseTextStreamAccumulator = ""

	parseTextStream(chunk: string) {
		this.parseTextStreamAccumulator += chunk

		// let text = ""
		let textContent: TextContent = {
			type: "text",
			content: "",
			partial: true,
		}
		let toolCalls: ToolCall[] = []

		let currentToolCall: ToolCall | undefined = undefined
		let currentParamName: ToolParamName | undefined = undefined
		let currentParamValueLines: string[] = []
		let textContentLines: string[] = []

		const rawLines = this.parseTextStreamAccumulator.split("\n")

		if (rawLines.length === 1) {
			const firstLine = rawLines[0].trim()
			if (!firstLine.startsWith("<t") && firstLine.startsWith("<")) {
				// (we ignore tags that start with <t since it's most like a <thinking> tag (and none of our tags start with t)
				// content is just starting, if it starts with < we can assume it's a tool call, so we'll wait for the next line
				console.log("skipping reason 1")
				return
			}
		}

		if (
			this.assistantMessageContent.length === 1 &&
			this.assistantMessageContent[0].partial // first element is always TextContent
		) {
			// we're updating text content, so if we have a partial xml tag on the last line we can ignore it until we get the full line.
			const lastLine = rawLines.at(-1)?.trim()
			if (lastLine && !lastLine.startsWith("<t") && lastLine.startsWith("<") && !lastLine.endsWith(">")) {
				console.log("skipping reason 2")
				return
			}
		}

		for (const line of rawLines) {
			const trimmed = line.trim()
			// if currenttoolcall or currentparamname look for closing tag, more efficient and safe
			if (currentToolCall && currentParamName && trimmed === `</${currentParamName}>`) {
				// End of a tool parameter
				currentToolCall.params[currentParamName] = currentParamValueLines.join("\n")
				currentParamName = undefined
				currentParamValueLines = []
				// currentParamValue = undefined
				continue
			} else if (currentToolCall && !currentParamName && trimmed === `</${currentToolCall.name}>`) {
				// End of a tool call
				currentToolCall.partial = false
				toolCalls.push(currentToolCall)
				currentToolCall = undefined
				continue
			}
			if (!currentParamName && trimmed.startsWith("<") && trimmed.endsWith(">")) {
				const tag = trimmed.slice(1, -1)
				if (toolCallNames.includes(tag as ToolCallName)) {
					// Start of a new tool call
					currentToolCall = { type: "tool_call", name: tag as ToolCallName, params: {}, partial: true }
					// This also indicates the end of the text content
					textContent.partial = false
					continue
				} else if (currentToolCall && toolParamNames.includes(tag as ToolParamName)) {
					// Start of a parameter
					currentParamName = tag as ToolParamName
					// currentToolCall.params[currentParamName] = ""
					continue
				}
			}

			if (currentToolCall && !currentParamName) {
				// current tool doesn't have a param match yet, it's likely partial so ignore
				continue
			}

			if (currentToolCall && currentParamName) {
				// add line to current param value
				currentParamValueLines.push(line)
				continue
			}

			// only add text content if we haven't started a tool yet
			if (textContent.partial) {
				textContentLines.push(line)
			}
		}

		if (currentToolCall) {
			// stream did not complete tool call, add it as partial
			if (currentParamName) {
				// tool call has a parameter that was not completed
				currentToolCall.params[currentParamName] = currentParamValueLines.join("\n")
			}
			toolCalls.push(currentToolCall)
		}

		textContent.content = textContentLines.join("\n")

		this.assistantMessageContent = [textContent, ...toolCalls]

		// Present the updated content
		this.presentAssistantMessage()
	}

	async recursivelyMakeClaudeRequests(
		userContent: UserContent,
		includeFileDetails: boolean = false
	): Promise<boolean> {
		if (this.abort) {
			throw new Error("ClaudeDev instance aborted")
		}

		if (this.consecutiveMistakeCount >= 3) {
			const { response, text, images } = await this.ask(
				"mistake_limit_reached",
				this.api.getModel().id.includes("claude")
					? `This may indicate a failure in his thought process or inability to use a tool properly, which can be mitigated with some user guidance (e.g. "Try breaking down the task into smaller steps").`
					: "Claude Dev uses complex prompts and iterative task execution that may be challenging for less capable models. For best results, it's recommended to use Claude 3.5 Sonnet for its advanced agentic coding capabilities."
			)
			if (response === "messageResponse") {
				userContent.push(
					...[
						{
							type: "text",
							text: `You seem to be having trouble proceeding. The user has provided the following feedback to help guide you:\n<feedback>\n${text}\n</feedback>`,
						} as Anthropic.Messages.TextBlockParam,
						...this.formatImagesIntoBlocks(images),
					]
				)
			}
			this.consecutiveMistakeCount = 0
		}

		// getting verbose details is an expensive operation, it uses globby to top-down build file structure of project which for large projects can take a few seconds
		// for the best UX we show a placeholder api_req_started message with a loading spinner as this happens
		await this.say(
			"api_req_started",
			JSON.stringify({
				request:
					userContent
						.map((block) => formatContentBlockToMarkdown(block, this.apiConversationHistory))
						.join("\n\n") + "\n\nLoading...",
			})
		)

		const [parsedUserContent, environmentDetails] = await this.loadContext(userContent, includeFileDetails)
		userContent = parsedUserContent
		// add environment details as its own text block, separate from tool results
		userContent.push({ type: "text", text: environmentDetails })

		await this.addToApiConversationHistory({ role: "user", content: userContent })

		// since we sent off a placeholder api_req_started message to update the webview while waiting to actually start the API request (to load potential details for example), we need to update the text of that message
		const lastApiReqIndex = findLastIndex(this.claudeMessages, (m) => m.say === "api_req_started")
		this.claudeMessages[lastApiReqIndex].text = JSON.stringify({
			request: userContent
				.map((block) => formatContentBlockToMarkdown(block, this.apiConversationHistory))
				.join("\n\n"),
		})
		await this.saveClaudeMessages()
		await this.providerRef.deref()?.postStateToWebview()

		try {
			const stream = await this.attemptApiRequest()
			let cacheCreationInputTokens = 0
			let cacheReadInputTokens = 0
			let inputTokens = 0
			let outputTokens = 0

			// todo add error listeners so we can return api error? or wil lfor await handle that below?

			let apiContentBlocks: Anthropic.ContentBlock[] = []
			this.currentStreamingContentIndex = 0
			this.assistantMessageContent = []
			this.didCompleteReadingStream = false
			this.userMessageContent = []
			this.userMessageContentReady = false
			this.didRejectTool = false
			this.presentAssistantMessageLocked = false
			this.presentAssistantMessageHasPendingUpdates = false
			this.parseTextStreamAccumulator = ""

			// this.chunkIndexToJsonParser.clear()
			for await (const chunk of stream) {
				switch (chunk.type) {
					case "message_start":
						console.log("message_start", chunk.message.content, chunk.message.usage)
						// tells us cache reads/writes/input/output
						const usage = chunk.message.usage
						cacheCreationInputTokens += usage.cache_creation_input_tokens || 0
						cacheReadInputTokens += usage.cache_read_input_tokens || 0
						inputTokens += usage.input_tokens || 0
						outputTokens += usage.output_tokens || 0
						break
					case "message_delta":
						// tells us stop_reason, stop_sequence, and output tokens along the way and at the end of the message
						console.log("message_delta", chunk.delta, chunk.usage)
						outputTokens += chunk.usage.output_tokens || 0
						break
					case "message_stop":
						// no usage data, just an indicator that the message is done
						console.log("message_stop", chunk.type)
						break
					case "content_block_start":
						console.log("content_block_start", chunk.index)
						// await delay(4_000)
						switch (chunk.content_block.type) {
							case "text":
								console.log("text", chunk.content_block.text)
								// this.assistantContentBlocks.push({
								// 	text: chunk.content_block.text,
								// 	toolCalls: [],
								// 	partial: true,
								// })
								apiContentBlocks.push(chunk.content_block)

								// we may receive multiple text blocks, in which case just insert a line break between them
								if (chunk.index > 0) {
									this.parseTextStream("\n")
								}

								this.parseTextStream(chunk.content_block.text)
								// this.assistantContentBlocks.at(-1)!.partial = true
								this.presentAssistantMessage()
								break
							// case "tool_use":
							// 	console.log(
							// 		"tool_use",
							// 		chunk.index,
							// 		chunk.content_block.id,
							// 		chunk.content_block.name,
							// 		chunk.content_block.input // input is always object, which will be streamed as partial json in content_block_delta. (this initial 'input' will always be an empty object)
							// 	)
							// 	apiContentBlocks.push(chunk.content_block)
							// 	this.assistantContentBlocks.push(chunk.content_block)
							// 	this.assistantContentBlocks.at(-1)!.partial = true
							// 	this.presentAssistantContent()
							// // Initialize the JSON parser with partial tokens enabled
							// // partialJsonParser =
							// this.getJsonParserForChunk(chunk.index)
						}
						break
					case "content_block_delta":
						console.log("content_block_delta", chunk.index)
						switch (chunk.delta.type) {
							case "text_delta":
								console.log("text_delta", chunk.delta.text)
								;(apiContentBlocks[chunk.index] as Anthropic.TextBlock).text += chunk.delta.text
								this.parseTextStream(chunk.delta.text)
								this.presentAssistantMessage()
								break
							// case "input_json_delta":
							// 	console.log("input_json_delta", chunk.delta.partial_json)
							// 	try {
							// 		// this.getJsonParserForChunk(chunk.index).write(chunk.delta.partial_json)
							// 	} catch (error) {
							// 		console.error("Error parsing input_json_delta", error)
							// 	}

							// 	// try {
							// 	// 	// JSONParser will always give us a token unless we pass in an empty/undefined value (in which case the promise would never resolve)
							// 	// 	if (chunk.delta.partial_json) {
							// 	// 		// need to await this since we dont want to create multiple jsonparsers in case the read stream comes in faster than the jsonparser can parse
							// 	// 		await this.updateAssistantContentWithPartialJson(
							// 	// 			chunk.index,
							// 	// 			chunk.delta.partial_json
							// 	// 		)
							// 	// 	}
							// 	// } catch (error) {
							// 	// 	// may be due to timeout, in which case we can safely ignore
							// 	// 	console.error("Error parsing input_json_delta", error)
							// 	// }
							// 	// this.presentAssistantContent()
							// 	break
						}
						break
					case "content_block_stop":
						// if (apiContentBlocks[chunk.index]!.type === "text") {
						// 	// we only call this for text block since partialJsonParser handles calling this for tool_use blocks (we only eve want to set partial to false and presentAssistantContent once for each block)
						// 	console.log(11)
						// 	this.assistantContentBlocks[chunk.index]!.partial = false
						// 	this.presentAssistantContent()
						// }

						console.log("content_block_stop", chunk.index)

						// instead of calling .end ourselves, the parser will automatically call it when it sees the end of the json object. (Calling this here can result in "Tokenizer ended in the middle of a token (state: ENDED). Either not all the data was received or the data was invalid." since there is a delay between the last chunk.delta.partial_json and the end of the content_block_delta)
						// partialJsonParser?.end()
						break
				}
			}
			this.didCompleteReadingStream = true

			console.log("contentBlocks", apiContentBlocks)

			let totalCost: string | undefined

			await this.say(
				"api_req_finished",
				JSON.stringify({
					tokensIn: inputTokens,
					tokensOut: outputTokens,
					cacheWrites: cacheCreationInputTokens,
					cacheReads: cacheReadInputTokens,
					cost:
						totalCost ||
						this.calculateApiCost(
							inputTokens,
							outputTokens,
							cacheCreationInputTokens,
							cacheReadInputTokens
						),
				})
			)

			// now add to apiconversationhistory
			// need to save assistant responses to file before proceeding to tool use since user can exit at any moment and we wouldn't be able to save the assistant's response
			let didEndLoop = false
			if (apiContentBlocks.length > 0) {
				// Remove 'partial' prop from assistantContentBlocks
				// const blocksWithoutPartial: Anthropic.Messages.ContentBlock[] = this.assistantContentBlocks.map(
				// 	(block) => {
				// 		const { partial, ...rest } = block
				// 		return rest
				// 	}
				// )
				await this.addToApiConversationHistory({ role: "assistant", content: apiContentBlocks })

				await pWaitFor(() => this.userMessageContentReady)

				const recDidEndLoop = await this.recursivelyMakeClaudeRequests(this.userMessageContent)
				didEndLoop = recDidEndLoop
			} else {
				// this should never happen! it there's no assistant_responses, that means we got no text or tool_use content blocks from API which we should assume is an error
				await this.say(
					"error",
					"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output."
				)
				await this.addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: "Failure: I did not provide a response." }],
				})
			}

			return didEndLoop // will always be false for now

			throw new Error("ClaudeDev fail")
			if (this.abort) {
				throw new Error("ClaudeDev instance aborted")
			}

			let assistantResponses: Anthropic.Messages.ContentBlock[] = []
			// let inputTokens = response.usage.input_tokens
			// let outputTokens = response.usage.output_tokens
			// let cacheCreationInputTokens =
			// 	(response as Anthropic.Beta.PromptCaching.Messages.PromptCachingBetaMessage).usage
			// 		.cache_creation_input_tokens || undefined
			// let cacheReadInputTokens =
			// 	(response as Anthropic.Beta.PromptCaching.Messages.PromptCachingBetaMessage).usage
			// 		.cache_read_input_tokens || undefined
			// @ts-ignore-next-line
			// let totalCost = response.usage.total_cost

			await this.say(
				"api_req_finished",
				JSON.stringify({
					tokensIn: inputTokens,
					tokensOut: outputTokens,
					cacheWrites: cacheCreationInputTokens,
					cacheReads: cacheReadInputTokens,
					cost:
						totalCost ||
						this.calculateApiCost(
							inputTokens,
							outputTokens,
							cacheCreationInputTokens,
							cacheReadInputTokens
						),
				})
			)

			// A response always returns text content blocks (it's just that before we were iterating over the completion_attempt response before we could append text response, resulting in bug)
			for (const contentBlock of response.content) {
				// type can only be text or tool_use
				if (contentBlock.type === "text") {
					assistantResponses.push(contentBlock)
					await this.say("text", contentBlock.text)
				} else if (contentBlock.type === "tool_use") {
					assistantResponses.push(contentBlock)
				}
			}

			// need to save assistant responses to file before proceeding to tool use since user can exit at any moment and we wouldn't be able to save the assistant's response
			if (assistantResponses.length > 0) {
				await this.addToApiConversationHistory({ role: "assistant", content: assistantResponses })
			} else {
				// this should never happen! it there's no assistant_responses, that means we got no text or tool_use content blocks from API which we should assume is an error
				await this.say(
					"error",
					"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output."
				)
				await this.addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: "Failure: I did not provide a response." }],
				})
			}

			let toolResults: Anthropic.ToolResultBlockParam[] = []
			let attemptCompletionBlock: Anthropic.Messages.ToolUseBlock | undefined
			let userRejectedATool = false
			for (const contentBlock of response.content) {
				if (contentBlock.type === "tool_use") {
					const toolName = contentBlock.name as ToolName
					const toolInput = contentBlock.input
					const toolUseId = contentBlock.id

					if (userRejectedATool) {
						toolResults.push({
							type: "tool_result",
							tool_use_id: toolUseId,
							content: "Skipping tool execution due to previous tool user rejection.",
						})
						continue
					}

					if (toolName === "attempt_completion") {
						attemptCompletionBlock = contentBlock
					} else {
						const [didUserReject, result] = await this.executeTool(toolName, toolInput)
						toolResults.push({ type: "tool_result", tool_use_id: toolUseId, content: result })

						if (didUserReject) {
							userRejectedATool = true
						}
					}
				}
			}

			// let didEndLoop = false

			// attempt_completion is always done last, since there might have been other tools that needed to be called first before the job is finished
			// it's important to note that claude will order the tools logically in most cases, so we don't have to think about which tools make sense calling before others
			if (attemptCompletionBlock) {
				let [_, result] = await this.executeTool(
					attemptCompletionBlock.name as ToolName,
					attemptCompletionBlock.input
				)
				// this.say(
				// 	"tool",
				// 	`\nattempt_completion Tool Used: ${attemptCompletionBlock.name}\nTool Input: ${JSON.stringify(
				// 		attemptCompletionBlock.input
				// 	)}\nTool Result: ${result}`
				// )
				if (result === "") {
					didEndLoop = true
					result = "The user is satisfied with the result."
				}
				toolResults.push({ type: "tool_result", tool_use_id: attemptCompletionBlock.id, content: result })
			}

			if (toolResults.length > 0) {
				if (didEndLoop) {
					await this.addToApiConversationHistory({ role: "user", content: toolResults })
					await this.addToApiConversationHistory({
						role: "assistant",
						content: [
							{
								type: "text",
								text: "I am pleased you are satisfied with the result. Do you have a new task for me?",
							},
						],
					})
				} else {
					const {
						didEndLoop: recDidEndLoop,
						inputTokens: recInputTokens,
						outputTokens: recOutputTokens,
					} = await this.recursivelyMakeClaudeRequests(toolResults)
					didEndLoop = recDidEndLoop
					inputTokens += recInputTokens
					outputTokens += recOutputTokens
				}
			}

			return { didEndLoop, inputTokens, outputTokens }
		} catch (error) {
			// this should never happen since the only thing that can throw an error is the attemptApiRequest, which is wrapped in a try catch that sends an ask where if noButtonTapped, will clear current task and destroy this instance. However to avoid unhandled promise rejection, we will end this loop which will end execution of this instance (see startTask)
			return { didEndLoop: true, inputTokens: 0, outputTokens: 0 }
		}
	}

	async loadContext(userContent: UserContent, includeFileDetails: boolean = false) {
		return await Promise.all([
			// Process userContent array, which contains various block types:
			// TextBlockParam, ImageBlockParam, ToolUseBlockParam, and ToolResultBlockParam.
			// We need to apply parseMentions() to:
			// 1. All TextBlockParam's text (first user message with task)
			// 2. ToolResultBlockParam's content/context text arrays if it contains "<feedback>" (see formatToolDeniedFeedback, attemptCompletion, executeCommand, and consecutiveMistakeCount >= 3) or "<answer>" (see askFollowupQuestion), we place all user generated content in these tags so they can effectively be used as markers for when we should parse mentions)
			Promise.all(
				userContent.map(async (block) => {
					if (block.type === "text") {
						return {
							...block,
							text: await parseMentions(block.text, cwd, this.urlContentFetcher),
						}
					} else if (block.type === "tool_result") {
						const isUserMessage = (text: string) => text.includes("<feedback>") || text.includes("<answer>")
						if (typeof block.content === "string" && isUserMessage(block.content)) {
							return {
								...block,
								content: await parseMentions(block.content, cwd, this.urlContentFetcher),
							}
						} else if (Array.isArray(block.content)) {
							const parsedContent = await Promise.all(
								block.content.map(async (contentBlock) => {
									if (contentBlock.type === "text" && isUserMessage(contentBlock.text)) {
										return {
											...contentBlock,
											text: await parseMentions(contentBlock.text, cwd, this.urlContentFetcher),
										}
									}
									return contentBlock
								})
							)
							return {
								...block,
								content: parsedContent,
							}
						}
					}
					return block
				})
			),
			this.getEnvironmentDetails(includeFileDetails),
		])
	}

	// Formatting responses to Claude

	private formatImagesIntoBlocks(images?: string[]): Anthropic.ImageBlockParam[] {
		return images
			? images.map((dataUrl) => {
					// data:image/png;base64,base64string
					const [rest, base64] = dataUrl.split(",")
					const mimeType = rest.split(":")[1].split(";")[0]
					return {
						type: "image",
						source: { type: "base64", media_type: mimeType, data: base64 },
					} as Anthropic.ImageBlockParam
			  })
			: []
	}

	private formatToolResponseWithImages(text: string, images?: string[]): ToolResponse {
		if (images && images.length > 0) {
			const textBlock: Anthropic.TextBlockParam = { type: "text", text }
			const imageBlocks: Anthropic.ImageBlockParam[] = this.formatImagesIntoBlocks(images)
			// Placing images after text leads to better results
			return [textBlock, ...imageBlocks]
		} else {
			return text
		}
	}

	async getEnvironmentDetails(includeFileDetails: boolean = false) {
		let details = ""

		// It could be useful for claude to know if the user went from one or no file to another between messages, so we always include this context
		details += "\n\n# VSCode Visible Files"
		const visibleFiles = vscode.window.visibleTextEditors
			?.map((editor) => editor.document?.uri?.fsPath)
			.filter(Boolean)
			.map((absolutePath) => path.relative(cwd, absolutePath).toPosix())
			.join("\n")
		if (visibleFiles) {
			details += `\n${visibleFiles}`
		} else {
			details += "\n(No visible files)"
		}

		details += "\n\n# VSCode Open Tabs"
		const openTabs = vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.map((tab) => (tab.input as vscode.TabInputText)?.uri?.fsPath)
			.filter(Boolean)
			.map((absolutePath) => path.relative(cwd, absolutePath).toPosix())
			.join("\n")
		if (openTabs) {
			details += `\n${openTabs}`
		} else {
			details += "\n(No open tabs)"
		}

		const busyTerminals = this.terminalManager.getTerminals(true)
		const inactiveTerminals = this.terminalManager.getTerminals(false)
		// const allTerminals = [...busyTerminals, ...inactiveTerminals]

		if (busyTerminals.length > 0 && this.didEditFile) {
			//  || this.didEditFile
			await delay(300) // delay after saving file to let terminals catch up
		}

		// let terminalWasBusy = false
		if (busyTerminals.length > 0) {
			// wait for terminals to cool down
			// terminalWasBusy = allTerminals.some((t) => this.terminalManager.isProcessHot(t.id))
			await pWaitFor(() => busyTerminals.every((t) => !this.terminalManager.isProcessHot(t.id)), {
				interval: 100,
				timeout: 15_000,
			}).catch(() => {})
		}

		// we want to get diagnostics AFTER terminal cools down for a few reasons: terminal could be scaffolding a project, dev servers (compilers like webpack) will first re-compile and then send diagnostics, etc
		/*
		let diagnosticsDetails = ""
		const diagnostics = await this.diagnosticsMonitor.getCurrentDiagnostics(this.didEditFile || terminalWasBusy) // if claude ran a command (ie npm install) or edited the workspace then wait a bit for updated diagnostics
		for (const [uri, fileDiagnostics] of diagnostics) {
			const problems = fileDiagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
			if (problems.length > 0) {
				diagnosticsDetails += `\n## ${path.relative(cwd, uri.fsPath)}`
				for (const diagnostic of problems) {
					// let severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? "Error" : "Warning"
					const line = diagnostic.range.start.line + 1 // VSCode lines are 0-indexed
					const source = diagnostic.source ? `[${diagnostic.source}] ` : ""
					diagnosticsDetails += `\n- ${source}Line ${line}: ${diagnostic.message}`
				}
			}
		}
		*/
		this.didEditFile = false // reset, this lets us know when to wait for saved files to update terminals

		// waiting for updated diagnostics lets terminal output be the most up-to-date possible
		let terminalDetails = ""
		if (busyTerminals.length > 0) {
			// terminals are cool, let's retrieve their output
			terminalDetails += "\n\n# Active Terminals"
			for (const busyTerminal of busyTerminals) {
				terminalDetails += `\n## ${busyTerminal.lastCommand}`
				const newOutput = this.terminalManager.getUnretrievedOutput(busyTerminal.id)
				if (newOutput) {
					terminalDetails += `\n### New Output\n${newOutput}`
				} else {
					// details += `\n(Still running, no new output)` // don't want to show this right after running the command
				}
			}
		}
		// only show inactive terminals if there's output to show
		if (inactiveTerminals.length > 0) {
			const inactiveTerminalOutputs = new Map<number, string>()
			for (const inactiveTerminal of inactiveTerminals) {
				const newOutput = this.terminalManager.getUnretrievedOutput(inactiveTerminal.id)
				if (newOutput) {
					inactiveTerminalOutputs.set(inactiveTerminal.id, newOutput)
				}
			}
			if (inactiveTerminalOutputs.size > 0) {
				terminalDetails += "\n\n# Inactive Terminals"
				for (const [terminalId, newOutput] of inactiveTerminalOutputs) {
					const inactiveTerminal = inactiveTerminals.find((t) => t.id === terminalId)
					if (inactiveTerminal) {
						terminalDetails += `\n## ${inactiveTerminal.lastCommand}`
						terminalDetails += `\n### New Output\n${newOutput}`
					}
				}
			}
		}

		// details += "\n\n# VSCode Workspace Errors"
		// if (diagnosticsDetails) {
		// 	details += diagnosticsDetails
		// } else {
		// 	details += "\n(No errors detected)"
		// }

		if (terminalDetails) {
			details += terminalDetails
		}

		if (includeFileDetails) {
			details += `\n\n# Current Working Directory (${cwd.toPosix()}) Files\n`
			const isDesktop = arePathsEqual(cwd, path.join(os.homedir(), "Desktop"))
			if (isDesktop) {
				// don't want to immediately access desktop since it would show permission popup
				details += "(Desktop files not shown automatically. Use list_files to explore if needed.)"
			} else {
				const [files, didHitLimit] = await listFiles(cwd, true, 200)
				const result = this.formatFilesList(cwd, files, didHitLimit)
				details += result
			}
		}

		return `<environment_details>\n${details.trim()}\n</environment_details>`
	}

	async formatToolDeniedFeedback(feedback?: string) {
		return `The user denied this operation and provided the following feedback:\n<feedback>\n${feedback}\n</feedback>`
	}

	async formatToolDenied() {
		return `The user denied this operation.`
	}

	async formatToolResult(result: string) {
		return result // the successful result of the tool should never be manipulated, if we need to add details it should be as a separate user text block
	}

	async formatToolError(error?: string) {
		return `The tool execution failed with the following error:\n<error>\n${error}\n</error>`
	}

	async sayAndCreateMissingParamError(toolName: ToolName, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Claude tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`
		)
		return await this.formatToolError(
			`Missing value for required parameter '${paramName}'. Please retry with complete response.`
		)
	}
}