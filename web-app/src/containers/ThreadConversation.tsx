import { safeSessionGet, safeSessionRemove } from '@/lib/safeStorage'
import { useModelToolsEnabled } from '@/hooks/useThreadToolGrants'
import { recordChatDispatch } from '@/lib/chatRun'
import { markConversationOpened } from '@/lib/messageEntry'
import { useRemoteComposer } from '@/lib/remote/composer'
import { chatLiveReply } from '@/lib/remote/live'
import { reportLiveReply } from '@/lib/remote/streams'
import { addSnapshotSink } from '@/lib/providerFetch'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useThreads } from '@/hooks/useThreads'
import { stopChatDelegation } from '@/lib/chatDelegation'
import { useThreadFind } from '@/hooks/useConversationFind'
import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import { useShallow } from 'zustand/react/shallow'
import { useMessageWindow } from '@/hooks/useMessageWindow'
import type { StickToBottomContext } from 'use-stick-to-bottom'
import { resolvePerfReduced, streamingThrottleMs, usePerfDetection } from '@/lib/perfMode'
import { useMessages } from '@/hooks/useMessages'
import {
  createChatFinishHandler,
  createChatToolCallHandler,
  type PartialContent,
} from '@/lib/chat/chatFinishHandler'
import { useThreadHistoryLoad } from '@/hooks/useThreadHistoryLoad'
import { useProcessAndSendMessage } from '@/hooks/useProcessAndSendMessage'
import { useContextSizeIncrease } from '@/hooks/useContextSizeIncrease'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTools } from '@/hooks/useTools'
import { useAppState } from '@/hooks/useAppState'
import { SESSION_STORAGE_PREFIX, TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useChat } from '@/hooks/use-chat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { renderInstructions } from '@/lib/instructionTemplate'
import { useChatRulesBlock } from '@/hooks/useChatRules'
import { composeSystemMessage } from '@/lib/chatRules'
import { generateId } from 'ai'
import { chatFollowUp } from '@/lib/chatSteering'
import type { UIMessage } from '@ai-sdk/react'
import { useChatSessions } from '@/stores/chat-session-store'
import { isServedByFlint } from '@/lib/platform/utils'
import { threadChanged, useRefreshWhenVisible } from '@/lib/threadRefresh'
import { followSentMessage } from '@/lib/followSentMessage'
import {
  convertThreadMessagesToUIMessages,
  countTerminalToolParts,
  mergeSettledToolParts,
} from '@/lib/messages'
import { newUserThreadContent } from '@/lib/completion'
import { computeActivePath, getVersionInfo, hasBranching } from '@/lib/message-branching'
import { useChatAttachments, NEW_THREAD_ATTACHMENT_KEY } from '@/hooks/useChatAttachments'
import { useStreamQuiet } from '@/hooks/useStreamQuiet'
import { isLocalContextOverflowMessage, parseContextOverflow } from '@/utils/error'
import { PREFLIGHT_CONTEXT_ERROR_PREFIX } from '@/lib/contextEstimate'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { parseServerContextLimit, rememberServerLimit } from '@/lib/contextLimitRecovery'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useThreadStatus } from '@/containers/ThreadStatusMark'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { notifyToolBatch } from '@/lib/agentTools'
import { closeBrowserSession } from '@/lib/browserTool'
import type { WidgetHost } from '@/lib/visualize/hostContext'
import { chatFoldersOf } from '@/lib/chatFolders'
import { useMemoryProposals } from '@/hooks/useMemoryProposals'
import { useMessageQueue } from '@/stores/message-queue-store'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import {
  resolveThreadModelSelection,
  useConversationModel,
  useConversationPane,
} from '@/hooks/useConversationPane'
import { useRagToolAvailability } from '@/hooks/threadConversation/useRagToolAvailability'
import { useBannerErrors } from '@/hooks/threadConversation/useBannerErrors'
import { useThreadVersioning } from '@/hooks/threadConversation/useThreadVersioning'
import { useChatCompaction } from '@/hooks/threadConversation/useChatCompaction'
import { useThreadQueue } from '@/hooks/threadConversation/useThreadQueue'
import { useErrorStamping } from '@/hooks/threadConversation/useErrorStamping'
import { useThreadDetails } from '@/hooks/threadConversation/useThreadDetails'
import { ThreadConversationView } from '@/containers/threadConversation/ThreadConversationView'

/** How long the chat stays idle before its agent browser is closed. */
const BROWSER_IDLE_CLOSE_MS = 3000

const CHAT_STATUS = {
  STREAMING: 'streaming',
  SUBMITTED: 'submitted',
} as const

type ThreadModel = {
  id: string
  provider: string
}

export type ThreadConversationProps = {
  /** The thread this conversation shows. Everything below is keyed by it. */
  threadId: string
  /** A model named in the URL, which wins over the thread's own. */
  searchThreadModel?: ThreadModel
  /** Controls beside the conversation's identity in the context bar (Split). */
  contextControls?: ReactNode
  /** Controls in a split pane's own header (change conversation, close pane). */
  paneControls?: ReactNode
}

/**
 * One Chat conversation: its messages, stream, tools and approvals, and its
 * composer. Rendered once by `/threads/$threadId`, or once per pane when the
 * conversation is split -- which is why it takes its thread id as a prop and
 * never reads the route.
 */
export function ThreadConversation({
  threadId,
  searchThreadModel,
  contextControls,
  paneControls,
}: ThreadConversationProps) {
  const serviceHub = useServiceHub()
  // Opening a chat draws its history at once; see lib/messageEntry.
  const openedThreadRef = useRef<string | null>(null)
  if (openedThreadRef.current !== threadId) {
    openedThreadRef.current = threadId
    markConversationOpened()
  }
  // Which pane this is. With the split closed there is one pane, always active.
  const pane = useConversationPane()
  const isSplit = Boolean(pane?.isSplit)
  const workProfilesOn = useWorkProfiles((s) => s.enabled)
  const isActive = !pane?.isSplit || pane.isActive
  const paneId = pane?.paneId ?? 'primary'
  // Read from callbacks the AI SDK captured when the session's Chat was made.
  const isSplitRef = useRef(isSplit)
  isSplitRef.current = isSplit
  const threadIdRef = useRef(threadId)
  threadIdRef.current = threadId
  // This conversation's messages as of the last commit (see below); the tool
  // call ids are read from them only when the conversation is left.
  const committedMessagesRef = useRef<typeof chatMessages>([])
  const fontSize = useInterfaceSettings((state) => state.fontSize)
  const messageZoom = useInterfaceSettings((state) => state.messageZoom)
  const setCurrentThreadId = useThreads((state) => state.setCurrentThreadId)
  const setMessages = useMessages((state) => state.setMessages)
  const addMessage = useMessages((state) => state.addMessage)
  const updateMessage = useMessages((state) => state.updateMessage)
  const deleteMessage = useMessages((state) => state.deleteMessage)
  const currentThread = useRef<string | undefined>(undefined)
  // A history read that failed, with the thread it belongs to: a late failure
  // from a chat the user has left must not show on this one.
  const [historyReadError, setHistoryReadError] = useState<{
    threadId: string
    message: string
  } | null>(null)
  const [historyReadAttempt, setHistoryReadAttempt] = useState(0)
  const [isReadingHistory, setIsReadingHistory] = useState(false)
  const currentHistoryError =
    historyReadError && historyReadError.threadId === threadId
      ? historyReadError.message
      : undefined

  useTools()

  // Get attachments for this thread
  const attachmentsKey = threadId ?? NEW_THREAD_ATTACHMENT_KEY
  const getAttachments = useChatAttachments((state) => state.getAttachments)
  const clearAttachmentsForThread = useChatAttachments(
    (state) => state.clearAttachments
  )
  const setAttachmentsForThread = useChatAttachments(
    (state) => state.setAttachments
  )

  // Session data for tool call tracking
  const getSessionData = useChatSessions((state) => state.getSessionData)
  const sessionData = getSessionData(threadId)

  // AbortController for cancelling tool calls
  const toolCallAbortController = useRef<AbortController | null>(null)

  // Approval promises started in onToolCall (so the popup appears immediately)
  // and awaited by the onFinish execution loop, keyed by toolCallId. Executing
  // stays in onFinish so the tool result lands on a completed assistant message
  // and the AI SDK's auto-resubmit (sendAutomaticallyWhen) fires.
  const toolApprovalPromises = useRef<Map<string, Promise<boolean>>>(new Map())

  const titleAbortRef = useRef<AbortController | null>(null)
  // Find in chat: the bar belongs to the conversation that is active.
  const { findOpen, findSeed, findWaitsForOther } = useThreadFind(threadId)
  const findRootRef = useRef<HTMLDivElement>(null)

  // Steering (Steer now / Ctrl+Enter in the composer) is delivered at the
  // tool loop's safe point; see chatFollowUp. Set once `sendMessage` exists.
  const sendSteeringRef = useRef<((text: string) => void) | null>(null)

  // Check if we should follow up with tool calls (respects abort signal)
  const lastBatchKey = useRef('')
  const followUpMessage = useCallback(
    ({ messages }: { messages: UIMessage[] }) =>
      chatFollowUp({
        messages,
        // The SDK asks again for the same state; a turn's hooks fire once.
        onBatchFinished: ({ key, names }) => {
          if (lastBatchKey.current === key) return
          lastBatchKey.current = key
          notifyToolBatch(threadIdRef.current, names)
        },
        aborted:
          !toolCallAbortController.current ||
          toolCallAbortController.current.signal.aborted,
        takeSteering: () =>
          sendSteeringRef.current
            ? useMessageQueue.getState().takeSteering(threadIdRef.current)
            : [],
        send: (text) => sendSteeringRef.current?.(text),
      }),
    []
  )

  // Subscribe directly to the thread data to ensure updates when model changes
  const thread = useThreads(useShallow((state) => state.threads[threadId]))
  // Paths in a reply link only when inside the folders attached to this chat.
  const chatPathRoots = useMemo(() => chatFoldersOf(thread), [thread])

  // This conversation's model: in a split pane its own thread's, otherwise
  // the global picker, exactly as before.
  const { selectedModel, selectedProvider } = useConversationModel()
  const toolsEnabled = useModelToolsEnabled(selectedModel, threadId)
  const getProviderByName = useModelProvider((state) => state.getProviderByName)
  // The same selection, read at call time from callbacks.
  const getModelSelection = useCallback(
    () =>
      isSplitRef.current
        ? resolveThreadModelSelection(threadId)
        : useModelProvider.getState(),
    [threadId]
  )
  // Handed to the transport while split, so each pane sends with its own model.
  const resolvePaneModel = useCallback(
    () => resolveThreadModelSelection(threadId),
    [threadId]
  )
  const threadRef = useRef(thread)
  const projectId = threadRef.current?.metadata?.project?.id

  // Get system message from thread's assistant instructions (if thread has an assigned assistant)
  // Only use assistant instructions if the thread was created with one (e.g., via a project)
  const threadAssistant = thread?.assistants?.[0]
  // Standing rules (Settings > Chat) follow the assistant's instructions.
  const chatRulesBlock = useChatRulesBlock(threadId, thread?.metadata?.project?.id)
  const systemMessage = composeSystemMessage(
    threadAssistant?.instructions
      ? renderInstructions(threadAssistant.instructions)
      : undefined,
    chatRulesBlock
  )

  // AH-032/AH-083: the transport takes a snapshot of every request and has
  // nowhere to return it -- the AI SDK owns the call -- so it hands it here.
  // Chat records which payload each request sent, which is what lets a Chat
  // turn be replayed from the record, and what lets a memory's use name the
  // exact request it went out in.
  useEffect(
    () =>
      addSnapshotSink((session, ref) => {
        if (session !== threadId) return
        recordChatDispatch(session, ref)
      }),
    [threadId]
  )

  useEffect(() => {
    threadRef.current = thread
  }, [thread])

  // Holds the partial assistant message while the model reloads after a
  // context-limit hit, so the user sees it instead of a blank gap.
  const [pendingContinueMessage, setPendingContinueMessage] =
    useState<UIMessage | null>(null)
  const [contextLimitError, setContextLimitError] = useState<Error | null>(null)
  // Per-thread so the shimmer survives navigating away and back while the
  // embedding run is still in flight.
  const processingEmbeddings = useAppState(
    (s) => !!s.embeddingThreads[threadId]
  )
  // Set while a finished turn's tools await approval or run. Reactive, unlike
  // `sessionData.tools`, so the queue drains once they settle.
  const threadBusy = useAppState((s) => !!s.busyThreads[threadId])
  const { t } = useTranslation()

  useEffect(() => {
    const raw = contextLimitError?.message
    // A refusal is the one moment a server names its own window without being
    // asked. Recorded against this exact provider/endpoint/model before the
    // message is turned into prose, so the next turn plans against the real
    // number instead of the same guess that just failed.
    if (!raw || !selectedModel?.id) return
    const provider = getProviderByName(selectedProvider)
    rememberServerLimit(
      {
        provider: selectedProvider ?? '',
        baseUrl: (provider?.base_url as string) ?? '',
        model: selectedModel.id,
      },
      parseServerContextLimit(contextLimitError, raw)
    )
  }, [contextLimitError, selectedModel?.id, selectedProvider, getProviderByName])

  // llama-server's overflow string is raw English; localize it, interpolating
  // the parsed request/context token counts when available.
  const contextBannerMessage = useMemo(() => {
    const raw = contextLimitError?.message
    if (!raw) return undefined
    // Flint's own pre-flight check: its message names the window and where it
    // came from, which the generic line would hide.
    if (raw.startsWith(PREFLIGHT_CONTEXT_ERROR_PREFIX)) return raw
    const info = parseContextOverflow(raw)
    if (info)
      return t('model-errors:contextOverflowDetail', {
        request: info.requestTokens.toLocaleString(),
        context: info.contextTokens.toLocaleString(),
      })
    if (!isLocalContextOverflowMessage(raw)) return raw
    return t('model-errors:contextOverflowGeneric')
  }, [contextLimitError, t])

  // Refs so onFinish (captured in closure) always calls the latest callbacks
  const globalOomError = useAppState((s) => s.oomError)
  const setOomError = useAppState((s) => s.setOomError)
  const globalBackendError = useAppState((s) => s.backendError)
  const setBackendError = useAppState((s) => s.setBackendError)
  // The router banners are app-wide state that follows the current thread.
  // In a split, the pane the user is not working in shows what its own
  // thread's messages recorded instead (see the resync effect below).
  const [ownBanner, setOwnBanner] = useState<{
    oom?: string
    backend?: string
  }>({})
  const oomErrorRaw = isActive ? globalOomError : ownBanner.oom
  const backendErrorRaw = isActive ? globalBackendError : ownBanner.backend

  // These signals come from the llamacpp router via global Tauri events.
  // Mask them when the active provider isn't llamacpp so a router crash
  // doesn't decorate chats running against MLX / OpenAI / Anthropic / etc.
  const isLlamacppActive = selectedProvider === 'llamacpp'
  const oomError = isLlamacppActive ? oomErrorRaw : undefined
  const backendError = isLlamacppActive ? backendErrorRaw : undefined

  const handleContextSizeIncreaseRef = useRef<(() => void) | null>(null)
  const regenerateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A pending post-resize regenerate must not fire into another thread.
  useEffect(
    () => () => {
      if (regenerateTimerRef.current) clearTimeout(regenerateTimerRef.current)
    },
    [threadId]
  )
  // Compacts and continues a reply that stopped because the window filled;
  // resolves false when it could not, and the banner is shown instead.
  const recoverContextLimitRef = useRef<
    ((message: UIMessage, partial: PartialContent) => Promise<boolean>) | null
  >(null)
  const setContinueFromContentRef = useRef<
    ((content: PartialContent) => void) | null
  >(null)
  const setChatMessagesRef = useRef<
    ((updater: (prev: UIMessage[]) => UIMessage[]) => void) | null
  >(null)
  // Holds the partial assistant output captured when the model stops with
  // `finishReason === 'length'`. Consumed by `handleContextSizeIncrease` so
  // the manual "Increase Context Size" button resumes from where the stream
  // stopped rather than regenerating from scratch.
  const pendingContinuationRef = useRef<{
    message: UIMessage
    content: PartialContent
  } | null>(null)
  // Set before a generation when the resulting assistant message should be
  // linked to a specific parent (versioning). Consumed once in onFinish.
  const pendingAssistantParentId = useRef<string | null>(null)
  // Holds the id of a stopped assistant message being resumed. Continuing must
  // extend the turn in place, not fork a new version, so onFinish deletes this
  // stale partial once the continued reply is persisted.
  const continueReplaceIdRef = useRef<string | null>(null)

  // Use the AI SDK chat hook
  const performanceMode = useInterfaceSettings((s) => s.performanceMode)
  const perfReduced = usePerfDetection((s) =>
    resolvePerfReduced(performanceMode, s.detection)
  )
  const streamingThrottle = streamingThrottleMs(perfReduced)
  const {
    messages: chatMessages,
    status,
    error,
    sendMessage,
    regenerate,
    setMessages: setChatMessages,
    stop,
    addToolOutput,
    updateRagToolsAvailability,
    setContinueFromContent,
    compactNow,
    sideQuestion,
  } = useChat({
    sessionId: threadId,
    sessionTitle: thread?.title,
    systemMessage,
    resolveModelSelection: isSplit ? resolvePaneModel : undefined,
    // One UI update per 50 ms of tokens (100 ms in reduced performance mode).
    experimental_throttle: streamingThrottle,
    onFinish: createChatFinishHandler({
      threadId,
      sessionData,
      serviceHub,
      projectId,
      getModelSelection,
      continueReplaceIdRef,
      pendingAssistantParentId,
      pendingContinuationRef,
      recoverContextLimitRef,
      setChatMessagesRef,
      toolCallAbortController,
      toolApprovalPromises,
      titleAbortRef,
      setContextLimitError,
      setPendingContinueMessage,
      // Both are declared further down; read when a reply finishes, as the
      // inline callback read them.
      resolveAssistantParent: (messageId) => resolveAssistantParent(messageId),
      getAddToolOutput: () => addToolOutput,
      addMessage,
      updateMessage,
      deleteMessage,
    }),
    onToolCall: createChatToolCallHandler({
      threadId,
      sessionData,
      toolApprovalPromises,
    }),
    sendAutomaticallyWhen: followUpMessage,
  })

  // Tool results land after onFinish saved the reply, so write them (and the
  // error of a failed or denied call) back to the stored message once they
  // exist; otherwise a reopened chat shows those calls as still running.
  const mergedTerminalRef = useRef<{ id: string; count: number } | null>(null)
  useEffect(() => {
    const live = chatMessages[chatMessages.length - 1]
    if (!live || live.role !== 'assistant') return
    // Only a newly settled tool part can change the stored copy; skip the
    // store lookup and the full content extraction on every other delta.
    const terminal = countTerminalToolParts(live)
    if (terminal === 0) return
    const done = mergedTerminalRef.current
    if (done && done.id === live.id && done.count === terminal) return
    const stored = useMessages
      .getState()
      .getMessages(threadId)
      .find((m) => m.id === live.id)
    if (!stored) return
    mergedTerminalRef.current = { id: live.id, count: terminal }
    const merged = mergeSettledToolParts(stored, live)
    if (merged) updateMessage(merged)
  }, [chatMessages, threadId, updateMessage])

  // Our error banners (oom/backend/context) can arrive out-of-band for the
  // router path, leaving the SDK stream stuck at 'submitted' so the
  // "Using tools…" indicator shimmers forever. Force a terminal status when a
  // banner is up — regenerate/reload restarts the turn anyway.
  const hasBannerError = !!(oomError || backendError || contextLimitError)
  const effectiveStatus = hasBannerError ? 'ready' : status

  // Only the tail of a long transcript is mounted; see useMessageWindow.
  const messageWindow = useMessageWindow(chatMessages.length, threadId)
  const revealMessage = messageWindow.reveal
  const stickRef = useRef<StickToBottomContext>(null)
  const revealMessageId = useCallback(
    (id: string) => {
      const at = chatMessages.findIndex((m) => m.id === id)
      if (at < 0) return
      // Mounting earlier messages grows the list; stop following the bottom
      // first, or the find jump is undone by the stick-to-bottom resize.
      stickRef.current?.stopScroll()
      revealMessage(at)
    },
    [chatMessages, revealMessage]
  )

  // Set on send; once the sent message is in the list, the view goes to it.
  const followSentRef = useRef(false)
  useEffect(() => {
    if (!followSentRef.current) return
    if (chatMessages[chatMessages.length - 1]?.role !== 'user') return
    followSentRef.current = false
    followSentMessage(stickRef.current)
  }, [chatMessages])

  // Kept as of the last commit, so leaving this conversation while split
  // forgets exactly its own runtime entries (cleanups run before new effects).
  useEffect(() => {
    committedMessagesRef.current = chatMessages
  }, [chatMessages])

  /**
   * Memories this chat proposed and nobody has answered yet.
   *
   * A temporary chat records nothing, so it never has anything to ask about.
   */
  const {
    proposals: memoryProposals,
    location: memoryLocation,
    reload: reloadMemoryProposals,
    onResolved: onMemoryProposalResolved,
  } = useMemoryProposals({
    sessionId: threadId,
    // So a project memory proposed in this chat can be listed and approved.
    janProjectId: thread?.metadata?.project?.id,
    enabled: threadId !== TEMPORARY_CHAT_ID,
  })
  const navigate = useNavigate()

  // Re-read once the turn is over. A proposal is written by a tool call during
  // the turn, so polling mid-stream would only find the previous turn's.
  useEffect(() => {
    if (status !== 'ready') return
    void reloadMemoryProposals()
  }, [status, reloadMemoryProposals])

  // The agent's browser (the `browser` tool) ends with the run. The chat's tool
  // loop runs in `onFinish`, with the stream already `ready` while a tool waits
  // for the user's approval or runs: the thread is marked busy for exactly that
  // time. So the browser is closed only once the chat is idle (or errored) AND
  // not busy, and has stayed so for a moment between the loop's steps.
  useEffect(() => {
    if ((status !== 'ready' && status !== 'error') || threadBusy) return
    const id = threadId
    const timer = setTimeout(() => void closeBrowserSession(id), BROWSER_IDLE_CLOSE_MS)
    return () => clearTimeout(timer)
  }, [status, threadId, threadBusy])

  // Update RAG tools availability when documents, model, or tool availability changes
  useRagToolAvailability({ thread, toolsEnabled, updateRagToolsAvailability })

  // Auto-scroll the reasoning container during streaming, pausing when the user scrolls up
  const {
    containerRef: reasoningContainerRef,
    isAtBottom: isReasoningAtBottom,
    handleScroll: handleReasoningScroll,
    scrollToBottom: scrollReasoningToBottom,
    forceScrollToBottom: forceScrollReasoningToBottom,
    reset: resetReasoningScroll,
  } = useAutoScroll()

  const lastIsAssistant = useMemo(() => {
    const last = chatMessages[chatMessages.length - 1]
    return !!last && last.role === 'assistant'
  }, [chatMessages])

  const quietSince = useStreamQuiet(status, chatMessages)

  useEffect(() => {
    if (status === 'streaming') {
      resetReasoningScroll()
    }
  }, [status, resetReasoningScroll])

  useEffect(() => {
    if (status === 'streaming') {
      scrollReasoningToBottom()
    }
  }, [status, chatMessages, scrollReasoningToBottom])

  // The current thread is the conversation the user is working in: this one
  // on its own, or the active pane's in a split.
  useEffect(() => {
    if (isActive) setCurrentThreadId(threadId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, isActive])

  // Load messages on first mount
  useThreadHistoryLoad({
    threadId,
    serviceHub,
    historyReadAttempt,
    currentThread,
    setIsReadingHistory,
    setHistoryReadError,
    setMessages,
    updateMessage,
    deleteMessage,
    setChatMessages,
  })

  // X01: in the browser `flint serve` serves, another tab or device may have
  // added to this thread. Read it again when this page comes back into view,
  // and show the server's copy when it differs and nothing is streaming here.
  useRefreshWhenVisible(isServedByFlint(), () => {
    if (useChatSessions.getState().sessions[threadId]?.isStreaming) return
    void serviceHub
      .messages()
      .fetchMessages(threadId)
      .then((fetched) => {
        if (useChatSessions.getState().sessions[threadId]?.isStreaming) return
        const shown = useMessages.getState().getMessages(threadId)
        if (!threadChanged(shown, fetched)) return
        setMessages(threadId, fetched)
        const activeRootId = (
          useThreads.getState().threads[threadId]?.metadata as
            | Record<string, unknown>
            | undefined
        )?.activeRootId as string | undefined
        setChatMessages(
          convertThreadMessagesToUIMessages(computeActivePath(fetched, activeRootId))
        )
      })
      .catch(() => {
        // Unreachable: the page keeps what it shows.
      })
  })

  useEffect(() => {
    return () => {
      // The title is not aborted here: it is small, belongs to the thread (not
      // this view) and was thrown away by every quick switch to a new chat.
      // In a split the other pane may be the current thread by now.
      if (
        !isSplitRef.current ||
        useThreads.getState().currentThreadId === threadIdRef.current
      ) {
        setCurrentThreadId(undefined)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The route component is reused across thread switches (no remount), so tear
  // down the in-flight tool loop and release approvals waiting on the thread we
  // are leaving. Cleanup captures the previous threadId; without this the
  // unresolved approval promise keeps that thread marked busy forever.
  useEffect(() => {
    // Stable ref object (never reassigned) — capture for the cleanup closure.
    const approvalPromises = toolApprovalPromises.current
    return () => {
      toolCallAbortController.current?.abort()
      toolCallAbortController.current = null
      approvalPromises.clear()
      // Leaving the thread ends its agent browser.
      void closeBrowserSession(threadId)
      // Children this conversation started stop with it: nothing is left
      // running for a chat the person has left.
      stopChatDelegation(threadId)
      useToolApprovalRequests
        .getState()
        .clearPendingForThread(threadId, { notify: true })
      // Drop per-thread timing/progress/diff state from the shared runtime
      // store. The cards for the thread we leave are unmounting, so a thread a
      // later visit cannot show another thread's diff. (code.tsx re-hydrates
      // its own diffs on mount, so it is unaffected by clearing here.) In a
      // split the other pane's cards are still on screen, so only this
      // conversation's entries go.
      if (isSplitRef.current) {
        useToolCallRuntime.getState().forget(
          committedMessagesRef.current.flatMap((m) =>
            m.parts.flatMap((p) => {
              const id = (p as { toolCallId?: string }).toolCallId
              return id ? [id] : []
            })
          )
        )
      } else {
        useToolCallRuntime.getState().reset()
      }
    }
  }, [threadId])

  // Resync the OOM/backend banner from message metadata on every thread switch.
  // Persisted by LlamacppOomListener at error time; unset state when this
  // thread carries no such metadata so the banner doesn't leak across threads.
  const threadMessagesForBanner = useMessages((s) => s.messages?.[threadId])
  useEffect(() => {
    let oom: string | undefined
    let be: string | undefined
    let ctx: string | undefined
    for (const m of threadMessagesForBanner ?? []) {
      const meta = m.metadata as Record<string, unknown> | undefined
      const o = meta?.oomError
      if (typeof o === 'string' && o.length > 0) oom = o
      const b = meta?.backendError
      if (typeof b === 'string' && b.length > 0) be = b
      const c = meta?.contextError
      if (typeof c === 'string' && c.length > 0) ctx = c
    }
    // Only the conversation the user is working in writes the app-wide router
    // banners; a split's other pane keeps its own copy.
    if (isActive) {
      useAppState.getState().setOomError(oom)
      useAppState.getState().setBackendError(be)
    }
    setOwnBanner((prev) =>
      prev.oom === oom && prev.backend === be ? prev : { oom, backend: be }
    )
    setContextLimitError(ctx ? new Error(ctx) : null)
  }, [threadId, threadMessagesForBanner, isActive])

  // Consolidated function to process and send a message
  const processAndSendMessage = useProcessAndSendMessage({
    threadId,
    thread,
    selectedModel,
    selectedProvider,
    toolsEnabled,
    serviceHub,
    attachmentsKey,
    getAttachments,
    setAttachmentsForThread,
    clearAttachmentsForThread,
    titleAbortRef,
    pendingAssistantParentId,
    addMessage,
    setChatMessages,
    sendMessage,
    t,
  })

  // Sends a text-only queued message, bypassing attachment processing entirely.
  // This prevents stale or new attachments from leaking into auto-sent queue items.
  const sendQueuedMessage = useCallback(
    async (text: string, steered = false) => {
      const messageId = generateId()
      const userMessage = newUserThreadContent(threadId, text, [], messageId)
      // janhq/jan#8864: marked where it entered a run as steering.
      if (steered) {
        userMessage.metadata = { ...(userMessage.metadata ?? {}), steered: true }
      }
      addMessage(userMessage)

      sendMessage({
        parts: [{ type: 'text', text }],
        id: messageId,
        metadata: userMessage.metadata,
      })
    },
    [sendMessage, threadId, addMessage]
  )

  // A widget's button sends its prompt as the user's next message, once the
  // current reply is done. Read through a ref so the host value stays stable.
  const widgetBusyRef = useRef(false)
  widgetBusyRef.current =
    status === CHAT_STATUS.STREAMING || status === CHAT_STATUS.SUBMITTED
  const widgetHost = useMemo<WidgetHost>(
    () => ({
      sendPrompt: (text) => {
        if (widgetBusyRef.current) return false
        void sendQueuedMessage(text)
        return true
      },
    }),
    [sendQueuedMessage]
  )

  sendSteeringRef.current = (text) => {
    void sendQueuedMessage(text, true).catch((err) =>
      console.error('Failed to deliver steering:', err)
    )
  }

  // Check for and send initial message from sessionStorage
  // Keyed by thread: the primary pane is reused across thread switches, so a
  // plain boolean would skip every later thread's first message.
  const initialMessageSentRef = useRef<string | null>(null)

  useEffect(() => {
    // Prevent duplicate sends
    if (initialMessageSentRef.current === threadId) return

    const initialMessageKey = `${SESSION_STORAGE_PREFIX.INITIAL_MESSAGE}${threadId}`

    const storedMessage = safeSessionGet(initialMessageKey)

    if (storedMessage) {
      // Mark as sent immediately to prevent duplicate sends
      safeSessionRemove(initialMessageKey)
      initialMessageSentRef.current = threadId

      // Process message asynchronously
      ;(async () => {
        try {
          const message = JSON.parse(storedMessage) as {
            text: string
            files?: Array<{ type: string; mediaType: string; url: string }>
          }

          await processAndSendMessage(message.text, message.files)
        } catch (error) {
          console.error('Failed to parse initial message:', error)
        }
      })()
    }
  }, [threadId, processAndSendMessage])

  // Dismissing a banner error also strips its persisted metadata.
  const { stripBannerMetadata, clearBannerErrors } = useBannerErrors({
    threadId,
    updateMessage,
    oomError,
    setOomError,
    backendError,
    setBackendError,
    contextLimitError,
    setContextLimitError,
  })

  // Handle submit from ChatInput
  const handleSubmit = useCallback(
    async (
      text: string,
      files?: Array<{ type: string; mediaType: string; url: string }>
    ) => {
      // The saved conversation could not be read: sending now would answer a
      // chat the model has not been shown and could overwrite what is on disk.
      if (currentHistoryError) return
      clearBannerErrors()
      // C14: what was sent is shown, even from a view above the end (a fork).
      followSentMessage(stickRef.current)
      followSentRef.current = true
      await processAndSendMessage(text, files)
    },
    [processAndSendMessage, clearBannerErrors, currentHistoryError]
  )

  // A paired phone's message goes through this same submit, and the reply
  // it streams is followed from here (lib/remote).
  useRemoteComposer('chat', threadId, handleSubmit, stop)
  useEffect(() => {
    reportLiveReply('chat', threadId, chatLiveReply(chatMessages, status))
  }, [threadId, chatMessages, status])
  useEffect(() => () => reportLiveReply('chat', threadId, null), [threadId])

  // Versioning: switching, regenerating, continuing, editing, deleting, forking.
  const {
    resolveAssistantParent,
    handleSwitchVersion,
    handleFork,
    handleRegenerate,
    chatMessagesRef,
    handleContinue,
    handleEditMessage,
    handleDeleteMessage,
  } = useThreadVersioning({
    threadId,
    updateMessage,
    addMessage,
    deleteMessage,
    setChatMessages,
    chatMessages,
    titleAbortRef,
    clearBannerErrors,
    stripBannerMetadata,
    contextLimitError,
    setContextLimitError,
    pendingAssistantParentId,
    continueReplaceIdRef,
    regenerate,
    setContinueFromContent,
    navigate,
    t,
  })

  // Handler for increasing context size
  const handleContextSizeIncrease = useContextSizeIncrease({
    threadId,
    selectedModel,
    selectedProvider,
    getProviderByName,
    serviceHub,
    handleRegenerate,
    chatMessagesRef,
    pendingContinuationRef,
    setContinueFromContentRef,
    continueReplaceIdRef,
    regenerateTimerRef,
    setContextLimitError,
    setPendingContinueMessage,
  })

  // Keep refs in sync so onFinish always calls the latest versions
  handleContextSizeIncreaseRef.current = handleContextSizeIncrease
  setContinueFromContentRef.current = setContinueFromContent
  setChatMessagesRef.current = setChatMessages

  // `/compact`, compaction after the window filled, and `/btw`.
  const { compacting, handleCompact, compactionInForce, compactionShownOnReply } =
    useChatCompaction({
      threadId,
      status,
      compactNow,
      sideQuestion,
      chatMessages,
      chatMessagesRef,
      handleRegenerate,
      t,
      thread,
      recoverContextLimitRef,
      setContinueFromContentRef,
      setPendingContinueMessage,
    })

  useEffect(() => {
    if (
      (oomError || backendError || contextLimitError) &&
      (status === 'streaming' || status === 'submitted')
    ) {
      try {
        stop()
      } catch (e) {
        console.warn('router error stop() threw:', e)
      }
    }
  }, [oomError, backendError, contextLimitError, status, stop])

  useEffect(() => {
    if (status === 'streaming' && pendingContinuationRef.current) {
      // The new turn is now flowing; drop the saved partial so it can't be
      // consumed by a later, unrelated "Increase Context Size" click.
      pendingContinuationRef.current = null
    }
    if (status === 'error' && pendingContinueMessage) {
      setPendingContinueMessage(null)
    }
  }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Message queue: held on error, the next one sent once the chat is ready.
  useThreadQueue({ threadId, status, threadBusy, sessionData, sendQueuedMessage })

  // A stream error lands on the turn it belongs to, or on the context banner.
  const localThreadMessages = useErrorStamping({
    threadId,
    status,
    error,
    chatMessages,
    updateMessage,
    selectedProvider,
    setContextLimitError,
  })

  // Clear the queue when navigating away from this thread
  useEffect(() => {
    return () => {
      useMessageQueue.getState().clearQueue(threadId)
    }
  }, [threadId])

  const threadModel = useMemo(
    () => searchThreadModel ?? thread?.model,
    [searchThreadModel, thread]
  )

  // The title as text: search highlighting can leave span markup in it.
  const plainThreadTitle = (thread?.title || t('common:newThread')).replace(
    /<span[^>]*>|<\/span>/g,
    ''
  )

  // The Details inspector ("What Flint is using") and the title that fades.
  const {
    detailsOpen,
    narrowView,
    setNarrowView,
    detailsPanelId,
    isPhone,
    titleRef,
    toggleDetails,
    closeDetails,
  } = useThreadDetails(isSplit)


  // Where this chat sits, as the sidebar shows it: its status mark, then
  // Pinned or its collection.
  const waitingHere = useToolApprovalRequests((s) =>
    Object.values(s.pending ?? {}).some((p) => p.threadId === threadId)
  )
  const threadStreaming = useChatSessions(
    (state) => state.sessions[threadId]?.isStreaming ?? false
  )
  const threadStatus = useThreadStatus(
    { updated: thread?.updated ?? 0 },
    threadStreaming,
    waitingHere,
    // Open here, so what it did is seen: the sidebar's dot clears.
    { id: threadId, selected: true }
  )

  // Per-message version counts for the `< n/m >` navigation control.
  const versionInfoById = useMemo(() => {
    const map: Record<string, { index: number; count: number }> = {}
    if (!localThreadMessages || !hasBranching(localThreadMessages)) return map
    for (const m of localThreadMessages) {
      const info = getVersionInfo(localThreadMessages, m)
      if (info.count > 1) map[m.id] = info
    }
    return map
  }, [localThreadMessages])

  return (
    <ThreadConversationView
      threadId={threadId}
      thread={thread}
      threadModel={threadModel}
      plainThreadTitle={plainThreadTitle}
      t={t}
      navigate={navigate}
      layout={{
        isSplit,
        isActive,
        paneId,
        workProfilesOn,
        contextControls,
        paneControls,
      }}
      details={{
        detailsOpen,
        narrowView,
        setNarrowView,
        detailsPanelId,
        isPhone,
        titleRef,
        toggleDetails,
        closeDetails,
      }}
      threadStatus={threadStatus}
      find={{ findOpen, findSeed, findWaitsForOther, findRootRef, revealMessageId }}
      transcript={{
        chatMessages,
        messageWindow,
        stickRef,
        fontSize,
        messageZoom,
        status,
        effectiveStatus,
        versionInfoById,
        pendingContinueMessage,
        lastIsAssistant,
        quietSince,
        processingEmbeddings,
        compactionInForce,
        compactionShownOnReply,
      }}
      reasoning={{
        containerRef: reasoningContainerRef,
        isAtBottom: isReasoningAtBottom,
        onScroll: handleReasoningScroll,
        onScrollToBottom: forceScrollReasoningToBottom,
      }}
      versioning={{
        handleRegenerate,
        handleFork,
        handleContinue,
        handleEditMessage,
        handleDeleteMessage,
        handleSwitchVersion,
      }}
      banner={{
        oomError,
        backendError,
        contextLimitError,
        error,
        contextBannerMessage,
        compacting,
        selectedProvider,
        handleCompact,
        handleContextSizeIncrease,
        handleRegenerate,
      }}
      memory={{ memoryProposals, memoryLocation, onMemoryProposalResolved }}
      composer={{
        handleSubmit,
        stop,
        toolCallAbortController,
        currentHistoryError,
        isReadingHistory,
        setHistoryReadAttempt,
      }}
      chatPathRoots={chatPathRoots}
      widgetHost={widgetHost}
    />
  )
}
