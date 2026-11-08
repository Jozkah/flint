import type { MutableRefObject } from 'react'
import type { UIMessage, UseChatHelpers } from '@ai-sdk/react'
import type { ServiceHub } from '@/services'
import type { SessionData } from '@/stores/chat-session-store'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import type { resolveThreadModelSelection } from '@/hooks/useConversationPane'
import { chatRunOf } from '@/lib/chatRun'
import {
  CHAT_DELEGATION_TOOL_NAMES,
  runChatDelegation,
} from '@/lib/chatDelegation'
import { deriveToolOutputCap } from '@/lib/context-manager'
import { knownContextWindow } from '@/lib/knownContextWindow'
import {
  NULL_DEVICE_RETRY_REASON,
  offerUnsandboxedRetry,
  commandProgram,
  nullRerunApprovalScope,
} from '@/lib/nullDeviceRetry'
import { executeWebTool, isNativeWebToolInRun } from '@/lib/webSearchTool'
import { isImageTool, runImageTool } from '@/lib/chatImageTools'
import {
  countOutputImages,
  isImageBlock,
  toolOutputWithImages,
  type ToolImage,
} from '@/lib/toolOutputImages'
import {
  AGENT_TOOL_NAMES,
  chatAgentToolRefusal,
  executeAgentTool,
} from '@/lib/agentTools'
import { browserCallOptions } from '@/lib/browserAgent'
import { hostCallOptions } from '@/lib/hostAsked'
import { secretCallOptions } from '@/lib/secretWrite'
import { closeBrowserSession } from '@/lib/browserTool'
import {
  VISUALIZE_TOOL_NAMES,
  isVisualizeTool,
} from '@/lib/visualize/constants'
import { executeVisualizeTool } from '@/lib/visualize/tools'
import { executeChatRead, isChatReadTool } from '@/lib/chatReadTool'
import { chatReadContextForThread } from '@/lib/chatMentionSources'
import { chatFolderToolOptions } from '@/lib/chatFolders'
import {
  deadToolNote,
  deadToolRefusal,
  isMethodNotFound,
  markToolDead,
  unknownToolError,
} from '@/lib/deadTools'
import { chatForcedPrompt } from '@/lib/chatToolGuard'
import { GIT_TOOL_NAME, gitApproval, gitRemoteFacts } from '@/lib/gitTool'
import { attributeGitInput } from '@/lib/gitAttribution'
import { chatLoopStop, chatTurnId, noteChatToolCall } from '@/lib/chatLoopGuard'
import {
  recordToolActivity,
  resourceOf,
  withToolActivity,
} from '@/lib/toolActivity'
import {
  APPROVAL_CANCELLED_TEXT,
  approvalDeniedText,
} from '@/lib/permissionOutcome'
import { redactDeep, redactText } from '@/lib/redactToolOutput'
import { fingerprintFor } from '@/lib/mcpFingerprint'
import { isAutoAllowedTool, serverForTool } from '@/lib/chat/threadHelpers'
import {
  requestAlwaysAskApproval,
  requestToolApproval,
} from '@/lib/chat/requestToolApproval'

/*
 * The Chat tool loop: runs the tool calls a finished reply asked for, one at a
 * time, after the assistant message has completed. Lifted out of the
 * conversation's onFinish (ThreadConversation.tsx) unchanged, so each result
 * still lands on a finished message and the AI SDK's auto-resubmit fires.
 */

export type ChatToolOutput = UseChatHelpers<UIMessage>['addToolOutput']

export type ChatToolLoopDeps = {
  threadId: string
  sessionData: SessionData
  serviceHub: ServiceHub
  projectId: string | undefined
  getModelSelection: () =>
    | ReturnType<typeof resolveThreadModelSelection>
    | ReturnType<typeof useModelProvider.getState>
  toolCallAbortController: MutableRefObject<AbortController | null>
  toolApprovalPromises: MutableRefObject<Map<string, Promise<boolean>>>
  /** Read when the loop starts: the conversation's own `addToolOutput`. */
  getAddToolOutput: () => ChatToolOutput
}

/**
 * Starts the loop for the tools `sessionData` collected during the reply.
 * Returns once the loop is under way; it settles on its own.
 */
export function runChatToolLoop(
  deps: ChatToolLoopDeps,
  finishedMessages: UIMessage[] | undefined,
  messageId: string
): void {
  const {
    threadId,
    sessionData,
    serviceHub,
    projectId,
    getModelSelection,
    toolCallAbortController,
    toolApprovalPromises,
    getAddToolOutput,
  } = deps
  const addToolOutput = getAddToolOutput()
  // Everything a tool produced is written through here, never through
  // `addToolOutput` directly. The transcript is a file that outlives the
  // run and gets exported, so a credential a tool happened to print -- a
  // `curl -v` trace, an error quoting a header -- must not reach it. One
  // entry point, because a call site that forgets is a call site that
  // silently persists the credential. AH-045.
  const persistToolOutput = async (
    part: Parameters<typeof addToolOutput>[0]
  ) => {
    if ('errorText' in part && typeof part.errorText === 'string') {
      addToolOutput({ ...part, errorText: await redactText(part.errorText) })
      return
    }
    if ('output' in part) {
      // Redaction reads text; an image's base64 is left alone.
      if (countOutputImages(part.output) > 0) {
        const blocks = part.output as unknown[]
        addToolOutput({
          ...part,
          output: await Promise.all(
            blocks.map((b) =>
              isImageBlock(b) ? b : redactDeep(b)
            )
          ),
        })
        return
      }
      addToolOutput({ ...part, output: await redactDeep(part.output) })
      return
    }
    addToolOutput(part)
  }

  // Execute tool calls here, after the assistant message has completed, so
  // each addToolOutput lands on a finished message and the SDK's
  // auto-resubmit (sendAutomaticallyWhen) fires. Approval is requested
  // earlier in onToolCall (popup appears without waiting for this callback);
  // we await that already-started promise here rather than prompting again.
  toolCallAbortController.current = new AbortController()
  const signal = toolCallAbortController.current.signal
  // Stopping the chat ends its agent browser at once, not when a tool call
  // it was waiting on finally returns.
  signal.addEventListener('abort', () => void closeBrowserSession(threadId), {
    once: true,
  })

  // The loop guard's history spans the whole reply to the user's
  // message, however many assistant message ids its steps are given.
  const loopTurn = chatTurnId(finishedMessages ?? [], messageId)

  const ragToolNames = useAppState.getState().ragToolNames
  const mcpToolNames = useAppState.getState().mcpToolNames

  // Keep the thread marked busy while awaiting approval and executing tools,
  // since streaming has already ended and isSessionBusy's tools-array read isn't reactive.
  useAppState.getState().setThreadBusy(threadId, true)

  // Tools run one at a time below, so the rest are genuinely queued.
  useToolCallRuntime
    .getState()
    .enqueue(
      sessionData.tools.map((tc) => tc.toolCallId),
      threadId
    )

  ;(async () => {
    for (const toolCall of sessionData.tools) {
      if (signal.aborted) {
        break
      }

      // A permission event written with no ending yet: if this iteration
      // throws before the call runs, the catch below ends it, so no call
      // is left "awaiting permission" in the record for good.
      let openPermission: Parameters<typeof recordToolActivity>[0] | null =
        null
      try {
        const toolName = toolCall.toolName
        // Flint's attribution on a commit or pull request, added before
        // the call is asked about, so the prompt shows what will land.
        if (toolName === GIT_TOOL_NAME) {
          toolCall.input = await attributeGitInput(
            toolCall.input,
            getModelSelection().selectedModel?.id,
            null,
            { id: threadId }
          )
        }
        // The same record Cowork writes (AH-050): Chat's tool calls are
        // part of what the conversation did, and a timeline or an audit
        // export that only knew Cowork's would be missing them.
        const activityCall = {
          toolCallId: toolCall.toolCallId,
          toolName,
          input: toolCall.input,
        }
        // AH-004: the run and the request that asked for this call, so
        // Chat's tool events join the same record Cowork writes instead of
        // standing alone with an empty run.
        const chatRun = chatRunOf(threadId)
        const activityCtx = {
          session: threadId,
          run: chatRun?.run ?? '',
          invocation: chatRun?.invocation ?? '',
          agentId: 'agent',
          source: 'chat' as const,
        }
        // Permission events carry the same run and invocation as the
        // call's other events: without them the fold keyed them as a
        // separate call, stuck at "allowed", which a restart then marked
        // interrupted although the call had finished.
        const permissionEvent = {
          call: toolCall.toolCallId,
          tool: toolName,
          session: threadId,
          run: activityCtx.run,
          invocation: activityCtx.invocation,
          agent_id: activityCtx.agentId,
          source: 'chat',
          resource: resourceOf(toolCall.input),
        }

        // A turn that has stopped getting anywhere -- the same tool failing
        // call after call -- is stopped here, whatever the arguments, the
        // same check Cowork makes (runLoopGuard.ts). The refusal tells the
        // model to stop and explain; it is shown in the tool card too.
        const loopStop = chatLoopStop(threadId, loopTurn)
        if (loopStop) {
          await recordToolActivity({
            ...permissionEvent,
            phase: 'refused',
            detail: `stopped: ${loopStop.verdict.detail}`,
          })
          await persistToolOutput({
            state: 'output-error',
            tool: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            errorText: loopStop.errorText,
          })
          // Told once already this turn and still calling tools: end the
          // turn rather than resubmitting into the same loop.
          if (loopStop.end) toolCallAbortController.current?.abort()
          continue
        }

        // A tool that runs without a prompt is still asked about when its
        // command looks destructive in this thread's workspace, or when it
        // would be one call past the consecutive auto-approval limit --
        // the same two checks Cowork makes (see chatToolGuard.ts).
        // `git` runs a read straight away, asks about a local change, and
        // asks about a push or pull request every time, naming the
        // remote and branch it reaches (read with read-only git calls).
        const git =
          toolName === GIT_TOOL_NAME ? gitApproval(toolCall.input) : null
        const forced = git?.alwaysAsk
          ? {
              reason: [
                git.reason,
                await gitRemoteFacts(git.plan, async (args) => {
                  const r = await executeAgentTool(
                    GIT_TOOL_NAME,
                    { args, ...(git.plan.cwd ? { cwd: git.plan.cwd } : {}) },
                    threadId,
                    { signal }
                  )
                  return r.error ? null : String(r.content ?? '')
                }),
              ]
                .filter(Boolean)
                .join(' '),
            }
          : isAutoAllowedTool(toolName, threadId) && !git
            ? await chatForcedPrompt(toolName, toolCall.input, threadId)
            : null
        const needsApproval =
          !isAutoAllowedTool(toolName, threadId) || forced !== null || git !== null
        if (needsApproval) {
          openPermission = { ...permissionEvent, phase: 'failed' }
          void recordToolActivity({
            ...permissionEvent,
            phase: 'awaiting-permission',
          })
        }
        const approved = !needsApproval
          ? true
          : forced
            ? await requestAlwaysAskApproval(
                { ...toolCall, toolName },
                threadId,
                { taskContext: forced.reason, signal }
              )
            : await (toolApprovalPromises.current.get(
                toolCall.toolCallId
              ) ??
                requestToolApproval({ ...toolCall, toolName }, threadId))
        toolApprovalPromises.current.delete(toolCall.toolCallId)

        openPermission = null
        if (!approved) {
          // A prompt withdrawn because the conversation stopped is not a
          // "no" from the user, and the transcript should not say it was.
          const refusal = useToolApprovalRequests
            .getState()
            .takeRefusal?.(toolCall.toolCallId)
          const refusalReason = useToolApprovalRequests
            .getState()
            .takeRefusalReason?.(toolCall.toolCallId)
          await recordToolActivity({
            ...permissionEvent,
            phase: 'refused',
            detail:
              refusal === 'cancelled'
                ? 'cancelled before the user answered'
                : 'denied by the user',
          })
          await persistToolOutput({
            state: 'output-error',
            tool: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            errorText:
              refusal === 'cancelled'
                ? APPROVAL_CANCELLED_TEXT
                : approvalDeniedText(refusalReason),
          })
          continue
        }
        // The person rewrote the command before allowing it once: run what
        // they approved, and say so in the record.
        const editedInput = useToolApprovalRequests
          .getState()
          .takeEditedInput?.(toolCall.toolCallId)
        if (editedInput && toolName === 'bash') {
          toolCall.input = { ...(toolCall.input as object), ...editedInput }
        }
        if (needsApproval) {
          void recordToolActivity({
            ...permissionEvent,
            phase: 'allowed',
            ...(editedInput ? { detail: 'allowed after the user edited the command' } : {}),
          })
        }

        // Timed from here, not from approval, so a long approval wait is
        // not reported as the tool being slow.
        useToolCallRuntime.getState().markRunning(toolCall.toolCallId)

        // The diff is kept for the record as well as shown; see below.
        let chatDiff: string | undefined
        const runChatTool = async () => {
        let result

        // A tool its server turned out not to implement is answered here
        // for the rest of the conversation (transcript audit #11).
        const deadRefusal = deadToolRefusal(threadId, toolName)
        if (deadRefusal) return { error: deadRefusal }

        if (isNativeWebToolInRun(toolName, threadId)) {
          // Bound a fetched page to the window this model has, as for MCP
          // results below, so a small-context model is not flooded.
          const webSelection = getModelSelection()
          result = await executeWebTool(
            toolName,
            toolCall.input,
            deriveToolOutputCap(
              knownContextWindow(
                webSelection.selectedModel as unknown as Parameters<
                  typeof knownContextWindow
                >[0],
                useModelProvider
                  .getState()
                  .getProviderByName(
                    webSelection.selectedProvider
                  ) as unknown as Parameters<typeof knownContextWindow>[1]
              ) ?? undefined
            )
          )
        } else if (isVisualizeTool(toolName)) {
          result = executeVisualizeTool(toolName, toolCall.input, threadId)
        } else if (isChatReadTool(toolName)) {
          result = await executeChatRead(
            toolCall.input,
            chatReadContextForThread(threadId)
          )
        } else if (isImageTool(toolName)) {
          result = await runImageTool(toolName, toolCall.input, threadId)
        } else if (chatAgentToolRefusal(toolName)) {
          result = { error: chatAgentToolRefusal(toolName) ?? '' }
        } else if (AGENT_TOOL_NAMES.has(toolName)) {
          const agentResult = await executeAgentTool(
            toolName,
            toolCall.input,
            threadId,
            {
              // The chat's attached folders, read-only, as Cowork
              // passes its own.
              ...chatFolderToolOptions(threadId),
              // Stopping the conversation withdraws a pending
              // `request_access` prompt instead of leaving it answerable.
              signal,
              // The browser tools ask the user themselves, and the question
              // has to sit under this call's card to be answerable there.
              ...browserCallOptions(toolName, toolCall.toolCallId),
              // The host tools ask too, and their question has to carry
              // this call's id to appear under its card.
              ...hostCallOptions(toolName, toolCall.toolCallId),
              // A write the credential scan would stop asks the user, under
              // this call's card.
              ...secretCallOptions(toolName, toolCall.toolCallId),
              taskLabel:
                useThreads.getState().threads[threadId]?.title ||
                'This conversation',
              // Live command output for the terminal card; raw, so it
              // keeps colours the model-facing result does not.
              onOutput: (text) =>
                useToolCallRuntime
                  .getState()
                  .appendOutput(toolCall.toolCallId, text),
            }
          )
          // The diff is display-only, so it goes to the runtime store rather
          // than into `result`: anything in `result` reaches the model, and a
          // full diff there would duplicate the file it just wrote.
          // The retry id is for this renderer only, never the model.
          const { diff, unsandboxedRetry, ...rest } = agentResult
          if (diff) {
            useToolCallRuntime
              .getState()
              .recordDiff(toolCall.toolCallId, diff)
            chatDiff = diff
          }
          result = rest
          // Failed only because Windows' null device refuses sandboxed
          // programs: offer this exact command outside the sandbox through
          // the approval prompt, and answer with what happened.
          if (toolName === 'bash' && rest.error && unsandboxedRetry) {
            const settled = await offerUnsandboxedRetry({
              threadId,
              retry: unsandboxedRetry,
              failure: rest.error,
              failureResources: rest.resources,
              program: commandProgram(toolCall.input),
              ask: () =>
                requestAlwaysAskApproval({ ...toolCall, toolName }, threadId, {
                  taskContext: NULL_DEVICE_RETRY_REASON,
                  scope: nullRerunApprovalScope(threadId, toolCall.input),
                  signal,
                }),
            })
            if (settled.firstAttempt) {
              useToolCallRuntime
                .getState()
                .recordFirstAttempt(toolCall.toolCallId, settled.firstAttempt)
            }
            result = settled.isError
              ? { error: settled.output, resources: settled.resources }
              : { content: settled.output, resources: settled.resources }
          }
        } else if (CHAT_DELEGATION_TOOL_NAMES.has(toolName)) {
          // The Cowork `task` family on the chat's own footing.
          const delegated = await runChatDelegation(
            threadId,
            getModelSelection().selectedModel?.id ?? '',
            {
              toolCallId: toolCall.toolCallId,
              toolName,
              input: toolCall.input,
            },
            signal
          )
          result = delegated.isError
            ? { error: delegated.output.replace(/^ERROR:\s*/, '') }
            : { content: delegated.output }
        } else if (ragToolNames.has(toolName)) {
          result = await serviceHub.rag().callTool({
            toolName,
            arguments: toolCall.input,
            threadId,
            projectId: projectId,
            scope: projectId ? 'project' : 'thread',
          })
        } else if (mcpToolNames.has(toolName)) {
          // An MCP result is injected into conversation history verbatim, so
          // a page-sized one can exhaust the context on its own. Give the
          // backend a budget scaled to the window this model actually has;
          // it narrows that against the user's configured ceiling.
          const ctxLen = getModelSelection().selectedModel?.settings
            ?.ctx_len?.controller_props?.value
          // A tool the user disabled must not run even if the model re-emits
          // a call it saw earlier in history: the disabled list only filters
          // what is advertised, not what executes.
          const disabledKey = `${serverForTool(toolName) ?? 'unknown'}::${toolName}`
          if (useToolAvailable.getState().getDisabledTools().includes(disabledKey)) {
            return { error: `Tool '${toolName}' is disabled.` }
          }
          // AH-041. The backend keeps the record of which servers the user
          // trusts and refuses a call to any other, so an approval that
          // happened here has to be handed over as something it issued.
          // Minted for every call rather than only untrusted ones: trust
          // can be withdrawn between the approval and the call, and an
          // unused ticket simply expires. Bound to the server definition
          // the approval was for, so a server edited in between is
          // refused rather than called.
          const server = serverForTool(toolName)
          const approvedFingerprint = useToolApprovalRequests
            .getState()
            .takeApprovedFingerprint?.(toolCall.toolCallId)
          const fingerprint = server
            ? await fingerprintFor(serviceHub.mcp(), server, approvedFingerprint)
            : undefined
          const approvalTicket =
            server && fingerprint
              ? await serviceHub
                  .mcp()
                  .allowOnceForServer(server, toolName, fingerprint)
                  .catch(() => undefined)
              : undefined
          // The call carries a token so Stop can cancel it while it runs.
          const cancellationToken = `tool_call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
          const appState = useAppState.getState()
          appState.setThreadCancelToolCall(threadId, () => {
            void serviceHub
              .mcp()
              .cancelToolCall(cancellationToken)
              .catch(() => {})
          })
          try {
            result = await serviceHub.mcp().callTool({
              toolName,
              serverName: server,
              arguments: toolCall.input,
              approvalTicket,
              cancellationToken,
              maxOutputChars: deriveToolOutputCap(
                typeof ctxLen === 'number' ? ctxLen : undefined
              ),
            })
          } finally {
            useAppState.getState().setThreadCancelToolCall(threadId, undefined)
          }
          const failure = result.error
            ? String(result.error)
            : (result as { isError?: unknown }).isError === true
              ? JSON.stringify(result.content ?? '')
              : undefined
          if (isMethodNotFound(failure)) {
            markToolDead(threadId, toolName, 'Method not found')
            result = {
              ...result,
              error: `${failure}${deadToolNote(toolName)}`,
            }
          }
        } else {
          result = {
            error: unknownToolError(toolName, [
              ...mcpToolNames,
              ...ragToolNames,
              ...AGENT_TOOL_NAMES,
              ...VISUALIZE_TOOL_NAMES,
            ]),
          }
        }
        return result
        }

        // Recorded around the execution itself: requested, running, and
        // how it ended, with its (redacted, bounded) output and its diff.
        const result = await withToolActivity(
          activityCall,
          activityCtx,
          signal,
          async () => {
            const raw = await runChatTool()
            return {
              ...raw,
              diff: chatDiff,
              // An MCP tool reports failure with `isError`, not `error`.
              isError:
                Boolean(raw.error) ||
                (raw as { isError?: unknown }).isError === true,
            }
          }
        )
        noteChatToolCall(threadId, loopTurn, {
          tool: toolName,
          input: toolCall.input,
          failed: result.isError,
          error: result.error
            ? String(result.error)
            : result.isError
              ? JSON.stringify(result.content ?? '')
              : undefined,
          result: result.isError
            ? undefined
            : JSON.stringify(result.content ?? ''),
        })

        if (result.error) {
          await persistToolOutput({
            state: 'output-error',
            tool: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            errorText: `Error: ${result.error}`,
          })
        } else {
          await persistToolOutput({
            tool: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            // A `read` of an image file also hands the model the image
            // (see `toolOutputImages`); the saved thread keeps the text.
            output:
              typeof result.content === 'string' &&
              (result as { images?: ToolImage[] }).images?.length
                ? toolOutputWithImages(
                    result.content,
                    (result as { images?: ToolImage[] }).images
                  )
                : result.content,
          })
        }
      } catch (error) {
        if (openPermission) {
          await recordToolActivity({
            ...openPermission,
            phase: signal.aborted ? 'cancelled' : 'failed',
            detail: error instanceof Error ? error.message : String(error),
          })
        }
        if ((error as Error).name !== 'AbortError') {
          console.error('Tool call error:', error)
          await persistToolOutput({
            state: 'output-error',
            tool: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            // An Error stringifies to {}, which hid the reason.
            errorText: `Error: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
          })
        }
      } finally {
        // Covers every exit from the iteration, including the denied path.
        useToolCallRuntime.getState().markSettled(toolCall.toolCallId)
      }
    }

    useToolCallRuntime.getState().settleRemaining(threadId)
    sessionData.tools = []
    toolApprovalPromises.current.clear()
    toolCallAbortController.current = null
    useAppState.getState().setThreadBusy(threadId, false)
  })().catch((error) => {
    if (error.name !== 'AbortError') {
      console.error('Tool call error:', error)
    }
    useToolCallRuntime.getState().settleRemaining(threadId)
    sessionData.tools = []
    toolApprovalPromises.current.clear()
    toolCallAbortController.current = null
    useAppState.getState().setThreadBusy(threadId, false)
  })
}
