import type { MutableRefObject } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import type { ChatInit } from 'ai'
import type { ThreadMessage } from '@janhq/core'
import type { ServiceHub } from '@/services'
import type { SessionData } from '@/stores/chat-session-store'
import { useMessages } from '@/hooks/useMessages'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useMessageErrors } from '@/stores/message-errors'
import { i18n } from '@/i18n/react-i18next-compat'
import { notifyAnswerFinished } from '@/lib/completionSound'
import {
  knownContextWindow,
  stoppedAtContextLimit,
} from '@/lib/knownContextWindow'
import { uiMessageHasMeaningfulContent } from '@/lib/messages'
import { buildAssistantThreadMessage } from '@/lib/assistantReply'
import { wasPersistedOnQuit } from '@/lib/persistInterruptedReplies'
import {
  getParentId,
  hasBranching,
  planContinuation,
  withActiveChild,
} from '@/lib/message-branching'
import { OUT_OF_CONTEXT_SIZE } from '@/utils/error'
import { isEmptyReply, isRefusal } from '@/lib/chatFinish'
import { resolveThreadModelSelection } from '@/hooks/useConversationPane'
import {
  isAutoAllowedTool,
  stampContextErrorOnThread,
} from '@/lib/chat/threadHelpers'
import { requestToolApproval } from '@/lib/chat/requestToolApproval'
import { runChatToolLoop, type ChatToolOutput } from '@/lib/chat/chatToolLoop'
import { maybeAutoTitleChat } from '@/lib/chat/chatAutoTitle'

/*
 * What a Chat conversation does when a reply finishes (`onFinish`) and when
 * the model calls a tool (`onToolCall`). Lifted out of ThreadConversation.tsx
 * unchanged: the component builds both on every render with that render's
 * values, exactly as the inline callbacks closed over them, and the AI SDK
 * session calls the latest pair (see hooks/use-chat).
 */

/** The text and reasoning a reply generated so far. */
export type PartialContent = { text: string; reasoning: string }

// What a resume replays as the assistant prefill, so a thinking model keeps
// its reasoning and not just its text.
export const partialOf = (message: UIMessage): PartialContent => {
  const collect = (type: 'text' | 'reasoning') =>
    message.parts
      .filter((p) => p.type === type)
      .map((p) => (p as { text: string }).text)
      .join('')
  return { text: collect('text'), reasoning: collect('reasoning') }
}

export const hasPartial = (content: PartialContent) =>
  !!(content.text || content.reasoning)

type ChatCallbacksInit = ChatInit<UIMessage>
export type ChatFinishEvent = Parameters<
  NonNullable<ChatCallbacksInit['onFinish']>
>[0]
type ChatToolCallEvent = Parameters<
  NonNullable<ChatCallbacksInit['onToolCall']>
>[0]

export type ChatModelSelection =
  | ReturnType<typeof resolveThreadModelSelection>
  | ReturnType<typeof useModelProvider.getState>

export type ChatFinishDeps = {
  threadId: string
  sessionData: SessionData
  serviceHub: ServiceHub
  projectId: string | undefined
  getModelSelection: () => ChatModelSelection
  continueReplaceIdRef: MutableRefObject<string | null>
  pendingAssistantParentId: MutableRefObject<string | null>
  pendingContinuationRef: MutableRefObject<{
    message: UIMessage
    content: PartialContent
  } | null>
  recoverContextLimitRef: MutableRefObject<
    ((message: UIMessage, partial: PartialContent) => Promise<boolean>) | null
  >
  setChatMessagesRef: MutableRefObject<
    ((updater: (prev: UIMessage[]) => UIMessage[]) => void) | null
  >
  toolCallAbortController: MutableRefObject<AbortController | null>
  toolApprovalPromises: MutableRefObject<Map<string, Promise<boolean>>>
  titleAbortRef: MutableRefObject<AbortController | null>
  setContextLimitError: (error: Error | null) => void
  setPendingContinueMessage: (message: UIMessage | null) => void
  resolveAssistantParent: (messageId: string | undefined) => string | null
  getAddToolOutput: () => ChatToolOutput
  addMessage: (message: ThreadMessage) => void | Promise<void>
  updateMessage: (message: ThreadMessage) => void
  deleteMessage: (threadId: string, messageId: string) => void
}

/** The conversation's `onFinish`, bound to one render's values. */
export function createChatFinishHandler(deps: ChatFinishDeps) {
  const {
    threadId,
    sessionData,
    getModelSelection,
    continueReplaceIdRef,
    pendingAssistantParentId,
    pendingContinuationRef,
    recoverContextLimitRef,
    setChatMessagesRef,
    titleAbortRef,
    setContextLimitError,
    setPendingContinueMessage,
    resolveAssistantParent,
    addMessage,
    updateMessage,
    deleteMessage,
  } = deps
  return function handleFinish(
    info: ChatFinishEvent,
    skipContextRecovery = false
  ): void {
    const { message, messages: finishedMessages, isAbort, isError, isDisconnect } = info
    const msgMeta = message.metadata as Record<string, unknown> | undefined
    const finishReason = msgMeta?.finishReason as string | undefined
    // Consume once per generation so a skipped persist (error/empty) can't
    // leak the replace target into a later, unrelated turn.
    const continueReplaceId = continueReplaceIdRef.current
    continueReplaceIdRef.current = null

    // Context limit hit: send partial content as prefill so the model continues
    // from where it stopped. The stream wrapper injects it as the first text-delta
    // of the new message, so the user sees the partial text immediately.
    if (!isAbort && finishReason === 'length') {
      const modelSelection = getModelSelection()
      const selectedModelState = modelSelection.selectedModel
      const usage = msgMeta?.usage as
        | { inputTokens?: number; outputTokens?: number }
        | undefined
      const totalTokens =
        (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
      // The window Flint actually knows, never a guess: a missing ctx_len used
      // to read as 32,768, which mislabelled output-cap stops on large
      // remote models and missed real overflows on small ones
      // (janhq/jan#8760). Unknown is not a context-limit verdict.
      const modelProviderState = useModelProvider.getState()
      const isContextLimit = stoppedAtContextLimit(
        totalTokens,
        knownContextWindow(
          selectedModelState as unknown as Parameters<
            typeof knownContextWindow
          >[0],
          modelProviderState.getProviderByName(
            modelSelection.selectedProvider
          ) as unknown as Parameters<typeof knownContextWindow>[1]
        )
      )

      if (isContextLimit && !skipContextRecovery) {
        // Stash the partial so the manual "Increase Context Size" button can
        // resume from here. Surface the standard banner with the manual
        // button — auto-increase was removed; the user explicitly opts in.
        // Reasoning too: a thinking model can fill the window before it
        // writes any text, and its reasoning is what to resume from.
        const partial = partialOf(message)
        const showBanner = () => {
          if (hasPartial(partial)) {
            pendingContinuationRef.current = { message, content: partial }
          }
          stampContextErrorOnThread(threadId)
          setContextLimitError(new Error(OUT_OF_CONTEXT_SIZE))
        }
        // The window filled mid-reply. With automatic compaction on, fold
        // the older conversation and carry on from the partial reply; the
        // banner is for when that cannot be done.
        const recover = recoverContextLimitRef.current
        if (recover) {
          void recover(message, partial).then((recovered) => {
            if (recovered) return
            showBanner()
            // Nothing carried the reply on, so keep what the model wrote:
            // finish again as a stopped turn, which persists the partial.
            continueReplaceIdRef.current = continueReplaceId
            handleFinish(info, true)
          })
          return
        }
        showBanner()
      }
      // Otherwise (the output-token cap, or a window that could not be
      // recovered): fall through and persist the partial marked as stopped so
      // the "Continue" button can resume it.
    }

    if (!isAbort && message.parts.length) setPendingContinueMessage(null)

    // Nothing would be persisted for an empty reply, so without this the
    // turn silently vanishes and the user cannot tell it failed. The error
    // goes on the user turn it answers: that message is persisted, and the
    // errorEntries effect copies the error into its metadata.error.
    if (
      !isDisconnect &&
      isEmptyReply({ message, isAbort, isError, finishReason })
    ) {
      const userTurnId =
        pendingAssistantParentId.current ?? resolveAssistantParent(undefined)
      pendingAssistantParentId.current = null
      if (userTurnId) {
        useMessageErrors
          .getState()
          .setError(userTurnId, i18n.t('model-errors:emptyReply'))
      }
    }

    // The provider declined to answer. Say so on the turn it answers, in
    // words that do not blame the key or the connection.
    if (!isAbort && !isDisconnect && isRefusal(finishReason)) {
      const userTurnId =
        pendingAssistantParentId.current ?? resolveAssistantParent(undefined)
      if (userTurnId) {
        useMessageErrors
          .getState()
          .setError(userTurnId, i18n.t('model-errors:refusal'))
      }
    }

    // The turn ended before completion (user hit Stop, or the model hit its
    // output-token cap). Persist the partial marked `stopped` so the UI can
    // offer a "Continue" affordance, and stamp the live message so the button
    // appears without waiting for a reload.
    const isStoppedTurn = isAbort || finishReason === 'length'

    // The reply is over only when it ended on its own with no tool calls
    // left to run: a step that ends in tool calls goes on once they settle.
    if (
      !isStoppedTurn &&
      !isError &&
      !isDisconnect &&
      finishReason !== 'tool-calls' &&
      finishReason !== 'error' &&
      sessionData.tools.length === 0
    ) {
      notifyAnswerFinished()
    }

    // Persist assistant message to backend (skip if aborted).
    // For continuations, message.parts already contains partial + new content
    // because the stream wrapper prepended the partial text as the first delta.
    if (
      message.role === 'assistant' &&
      uiMessageHasMeaningfulContent(message) &&
      // Saved already as an interrupted reply while the app was closing.
      !wasPersistedOnQuit(message.id)
    ) {
      const messageMetadata = {
        ...((message.metadata || {}) as Record<string, unknown>),
        ...(isStoppedTurn ? { stopped: true } : {}),
      }

      if (isStoppedTurn) {
        setChatMessagesRef.current?.((prev) =>
          prev.map((m) =>
            m.id === message.id
              ? {
                  ...m,
                  metadata: {
                    ...(m.metadata as Record<string, unknown> | undefined),
                    stopped: true,
                  },
                }
              : m
          )
        )
      }

      // A continuation resumes a stopped turn: the stale partial is deleted
      // below so the continued reply takes its place instead of forking a new
      // version. Inherit the partial's parent so the branch link holds.
      const continuation = planContinuation(
        useMessages.getState().getMessages(threadId),
        message.id,
        continueReplaceId,
        pendingAssistantParentId.current
      )
      pendingAssistantParentId.current = null

      let parentForAssistant = continuation.parentId

      // Never persist a detached assistant in a branched thread: if the
      // pending link was lost (e.g. a multi-step turn consumed the ref before
      // this reply finished), fall back to the user message this reply
      // answers. A null parentId would make computeActivePath treat the
      // assistant as a phantom root and drop it from the visible path.
      if (
        parentForAssistant == null &&
        hasBranching(useMessages.getState().getMessages(threadId))
      ) {
        parentForAssistant = resolveAssistantParent(undefined)
      }

      const assistantMessage: ThreadMessage = buildAssistantThreadMessage({
        message,
        threadId,
        existing: useMessages
          .getState()
          .getMessages(threadId)
          .find((m) => m.id === message.id),
        metadata: messageMetadata,
        parentId: parentForAssistant,
      })

      const existingMessages = useMessages.getState().getMessages(threadId)
      const existingMessage = existingMessages.find(
        (m) => m.id === message.id
      )

      if (existingMessage) {
        // Preserve the existing branch link on re-runs of onFinish.
        const existingParent = getParentId(existingMessage)
        updateMessage(
          existingParent != null
            ? {
                ...assistantMessage,
                metadata: {
                  ...assistantMessage.metadata,
                  parentId: existingParent,
                },
              }
            : assistantMessage
        )
      } else {
        addMessage(assistantMessage)
        // New generation becomes the active branch under its parent so
        // version navigation lands on the latest reply by default.
        if (parentForAssistant) {
          const parent = existingMessages.find(
            (m) => m.id === parentForAssistant
          )
          if (parent) updateMessage(withActiveChild(parent, assistantMessage.id))
        }
      }

      // Drop the stale partial so the resumed turn replaces it in place
      // rather than appearing as a separate version of the same reply.
      if (continuation.deletePartialId) {
        deleteMessage(threadId, continuation.deletePartialId)
        useMessageErrors.getState().clearError(continuation.deletePartialId)
      }

      for (const m of existingMessages) {
        const meta = m.metadata as Record<string, unknown> | undefined
        if (meta?.error) {
          const rest = { ...meta }
          delete rest.error
          updateMessage({ ...m, metadata: rest })
        }
        useMessageErrors.getState().clearError(m.id)
      }
    }
    runChatToolLoop(deps, finishedMessages, message.id)

    if (!isAbort) {
      maybeAutoTitleChat(threadId, titleAbortRef)
    }
  }
}

/** The conversation's `onToolCall`, bound to one render's values. */
export function createChatToolCallHandler(
  deps: Pick<ChatFinishDeps, 'threadId' | 'sessionData' | 'toolApprovalPromises'>
) {
  const { threadId, sessionData, toolApprovalPromises } = deps
  return ({ toolCall }: ChatToolCallEvent) => {
    // Collect the tool for the onFinish execution loop, and request approval
    // right now so the popup appears immediately instead of waiting for the
    // stream's terminal finish chunk (a stalled stream would otherwise leave
    // the tool at "Running..." with no popup). Execution itself stays in
    // onFinish so the tool result lands on a completed message. Internal tools
    // never prompt (see isAutoAllowedTool).
    sessionData.tools.push(toolCall)
    if (
      !isAutoAllowedTool(toolCall.toolName, threadId) &&
      !toolApprovalPromises.current.has(toolCall.toolCallId)
    ) {
      toolApprovalPromises.current.set(
        toolCall.toolCallId,
        requestToolApproval(toolCall, threadId)
      )
    }
  }
}
