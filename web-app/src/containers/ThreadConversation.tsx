import { safeSessionGet, safeSessionRemove } from '@/lib/safeStorage'
import { useModelToolsEnabled } from '@/hooks/useThreadToolGrants'
import { recordChatDispatch } from '@/lib/chatRun'
import { switchedFromOf } from '@/lib/assistantSwitch'
import { markConversationOpened } from '@/lib/messageEntry'
import { useRemoteChatActions, useRemoteComposer } from '@/lib/remote/composer'
import { sendQueuedViaComposer } from '@/lib/remote/queuedSend'
import { chatLiveReply } from '@/lib/remote/live'
import { reportLiveReply } from '@/lib/remote/streams'
import { addSnapshotSink } from '@/lib/providerFetch'
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useTextOverflow } from '@/hooks/useTextOverflow'
import { useNavigate } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { useMediaQuery } from '@/hooks/useMediaQuery'

import HeaderPage from '@/containers/HeaderPage'
import { ExportItems, ExportSubmenu } from '@/components/ExportMenu'
import { SaveChatPicturesItem } from '@/components/SaveChatPicturesItem'
import { docFromThread } from '@/lib/exportDoc'
import { useThreads } from '@/hooks/useThreads'
import ChatInput from '@/containers/ChatInput'
import { ChatPaneDropZone } from '@/components/ChatPaneDropZone'
import { FolderTrustBanner } from '@/containers/FolderTrustBanner'
import { ChatTasks } from '@/containers/ChatTasks'
import { CoworkChildApprovals } from '@/containers/CoworkChildApprovals'
import { stopChatDelegation } from '@/lib/chatDelegation'
import { ChatWorkProfilePicker } from '@/containers/ChatWorkProfilePicker'
import { forkThread } from '@/lib/forkThread'
import { ConversationFindBar } from '@/containers/ConversationFindBar'
import {
  useConversationFind,
  useThreadFind,
} from '@/hooks/useConversationFind'
import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import { useShallow } from 'zustand/react/shallow'
import { MessageItem } from '@/containers/MessageItem'
import { useMessageWindow } from '@/hooks/useMessageWindow'
import type { StickToBottomContext } from 'use-stick-to-bottom'
import {
  resolvePerfReduced,
  streamingThrottleMs,
  usePerfDetection,
} from '@/lib/perfMode'

import { useMessages } from '@/hooks/useMessages'
import {
  readDetailsOpen,
  stampContextErrorOnThread,
  writeDetailsOpen,
} from '@/lib/chat/threadHelpers'
import {
  createChatFinishHandler,
  createChatToolCallHandler,
  hasPartial,
  partialOf,
  type PartialContent,
} from '@/lib/chat/chatFinishHandler'
import { useThreadHistoryLoad } from '@/hooks/useThreadHistoryLoad'
import { useProcessAndSendMessage } from '@/hooks/useProcessAndSendMessage'
import { useContextSizeIncrease } from '@/hooks/useContextSizeIncrease'
import { ConversationErrorNotice } from '@/containers/ConversationErrorNotice'
import { BRANCH_CHANGED_EVENT, repairActiveRoot, setActiveBranch as setActiveBranchFor } from '@/lib/branchSelect'
import { useMessageErrors } from '@/stores/message-errors'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTools } from '@/hooks/useTools'
import { useAppState } from '@/hooks/useAppState'
import { useLatestCallback } from '@/hooks/useLatestCallback'
import { SESSION_STORAGE_PREFIX, TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useChat } from '@/hooks/use-chat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { describeChatFailure } from '@/lib/endpointDiagnostics'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { renderInstructions } from '@/lib/instructionTemplate'
import { useChatRulesBlock } from '@/hooks/useChatRules'
import { composeSystemMessage } from '@/lib/chatRules'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationLoadEarlier,
} from '@/components/ai-elements/conversation'
import { generateId } from 'ai'
import { chatFollowUp, nextChatTurn, stopChatTurn } from '@/lib/chatSteering'
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
import { resolveAssistantParentIn } from '@/lib/assistantReply'
import { registerReplyContext } from '@/lib/persistInterruptedReplies'
import { newUserThreadContent } from '@/lib/completion'
import {
  computeActivePath,
  backfillParentIds,
  makeSibling,
  getSiblings,
  getVersionInfo,
  hasBranching,
  removeFromTree,
} from '@/lib/message-branching'
import { ThreadMessage } from '@janhq/core'
import {
  useChatAttachments,
  NEW_THREAD_ATTACHMENT_KEY,
} from '@/hooks/useChatAttachments'
import { useAttachments } from '@/hooks/useAttachments'
import { PromptProgress } from '@/components/PromptProgress'
import { modelWaitStatus } from '@/lib/runStatus'
import { useStreamQuiet } from '@/hooks/useStreamQuiet'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import {
  isContextOverflowMessage,
  isLocalContextOverflowMessage,
  parseContextOverflow,
} from '@/utils/error'
import { PREFLIGHT_CONTEXT_ERROR_PREFIX } from '@/lib/contextEstimate'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { toast } from 'sonner'
import { CompactingIndicator, CompactionDivider } from '@/containers/CompactionDivider'
import {
  readChatCompaction,
  writeChatCompaction,
  registerChatCompactor,
  registerChatSideQuestion,
} from '@/lib/chatCompaction'
import {
  parseServerContextLimit,
  rememberServerLimit,
} from '@/lib/contextLimitRecovery'
import { CompactionSummaryError, resolveAutoCompact } from '@/lib/compaction'
import { getCompactionPolicy } from '@/lib/compactionPolicy'
import { Button } from '@/components/ui/button'
import {
  Columns2,
  Download,
  Loader2,
  MoreHorizontal,
  PanelRight,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Icon } from '@/components/ui/icon'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Chip } from '@/components/ui/chip'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatMessageTime } from '@/utils/formatMessageTime'
import {
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'
import {
  ThreadStatusMark,
  useThreadStatus,
} from '@/containers/ThreadStatusMark'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { notifyToolBatch } from '@/lib/agentTools'
import { closeBrowserSession } from '@/lib/browserTool'
import { WidgetHostContext, type WidgetHost } from '@/lib/visualize/hostContext'
import { chatFoldersOf } from '@/lib/chatFolders'
import { PathRootsContext } from '@/lib/codeOpen'
import { ChatFoldersChip } from '@/containers/ChatFoldersChip'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import { TemporaryChatBanner } from '@/containers/TemporaryChatBanner'
import {
  WhatJanIsUsingPanel,
  WhatJanIsUsingToggle,
} from '@/containers/WhatJanIsUsing'
import { MemoryProposalList } from '@/containers/MemoryProposalCard'
import { useMemoryProposals } from '@/hooks/useMemoryProposals'
import { route } from '@/constants/routes'
import { ExtensionTypeEnum, VectorDBExtension } from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'
import { warnIfProjectFilesChanged } from '@/lib/projectFileFreshness'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { useMessageQueue } from '@/stores/message-queue-store'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import {
  resolveThreadModelSelection,
  useConversationModel,
  useConversationPane,
} from '@/hooks/useConversationPane'
import { ACTIVE_PANE_RING } from '@/hooks/useCoworkPane'
import {
  paneDraftScope,
  useSplitConversation,
} from '@/hooks/useSplitConversation'

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

  // Global disabled-tools set; re-run the effect below when it changes.
  const disabledTools = useToolAvailable((state) => state.disabledTools)

  // Update RAG tools availability when documents, model, or tool availability changes
  useEffect(() => {
    const checkDocumentsAvailability = async () => {
      const hasThreadDocuments = Boolean(thread?.metadata?.hasDocuments)
      let hasProjectDocuments = false

      // Check if thread belongs to a project and if that project has files
      const projectId = thread?.metadata?.project?.id
      if (projectId) {
        try {
          const ext = ExtensionManager.getInstance().get<VectorDBExtension>(
            ExtensionTypeEnum.VectorDB
          )
          if (ext?.listAttachmentsForProject) {
            const projectFiles = await ext.listAttachmentsForProject(projectId)
            hasProjectDocuments = projectFiles.length > 0
            void warnIfProjectFilesChanged(projectId, projectFiles)
          }
        } catch (error) {
          console.warn('Failed to check project files:', error)
        }
      }

      const hasDocuments = hasThreadDocuments || hasProjectDocuments
      const ragFeatureAvailable = Boolean(useAttachments.getState().enabled)
      const modelSupportsTools = toolsEnabled

      updateRagToolsAvailability(
        hasDocuments,
        modelSupportsTools,
        ragFeatureAvailable
      )
    }

    checkDocumentsAvailability()
  }, [
    thread?.metadata?.hasDocuments,
    thread?.metadata?.project?.id,
    toolsEnabled,
    updateRagToolsAvailability,
    disabledTools, // Re-run when tools are enabled/disabled
  ])

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

  const stripBannerMetadata = useCallback(() => {
    const tmsgs = useMessages.getState().getMessages(threadId)
    for (const m of tmsgs) {
      const meta = m.metadata as Record<string, unknown> | undefined
      if (!meta) continue
      if (
        meta.oomError == null &&
        meta.backendError == null &&
        meta.contextError == null
      )
        continue
      const nextMeta = { ...meta }
      delete nextMeta.oomError
      delete nextMeta.backendError
      delete nextMeta.contextError
      updateMessage({ ...m, metadata: nextMeta })
    }
  }, [threadId, updateMessage])

  // Dismiss any active thread-level banner error and strip its persisted
  // metadata. The banner stands in for a failed last assistant turn (hidden by
  // the render filter), so leaving it set would blank a healthy assistant on
  // whatever branch we navigate to next.
  const clearBannerErrors = useCallback(() => {
    if (oomError) setOomError(undefined)
    if (backendError) setBackendError(undefined)
    if (contextLimitError) setContextLimitError(null)
    if (oomError || backendError || contextLimitError) stripBannerMetadata()
  }, [
    oomError,
    setOomError,
    backendError,
    setBackendError,
    contextLimitError,
    stripBannerMetadata,
  ])

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

  // Versioning helpers --------------------------------------------------------

  // Assign parentId along the current linear path the first time a thread forks,
  // so siblings and subtrees are well-defined. Idempotent. Returns the store.
  const ensureBranched = useCallback(() => {
    const msgs = useMessages.getState().getMessages(threadId)
    if (hasBranching(msgs)) return msgs
    const filled = backfillParentIds(msgs)
    filled.forEach((m) => updateMessage(m))
    return useMessages.getState().getMessages(threadId)
  }, [threadId, updateMessage])

  // Make `node` the active branch under its parent (or active root).
  const setActiveBranch = useCallback(
    (node: ThreadMessage) => setActiveBranchFor(threadId, node),
    [threadId]
  )

  // Rebuild the rendered conversation from the active path in the store.
  const syncActivePath = useCallback(() => {
    const msgs = useMessages.getState().getMessages(threadId)
    const activeRootId = (
      useThreads.getState().threads[threadId]?.metadata as
        | Record<string, unknown>
        | undefined
    )?.activeRootId as string | undefined
    setChatMessages(
      convertThreadMessagesToUIMessages(computeActivePath(msgs, activeRootId))
    )
  }, [threadId, setChatMessages])

  // A version switched from the phone: show (and send from) the new path.
  useEffect(() => {
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<{ threadId?: string }>).detail?.threadId === threadId)
        syncActivePath()
    }
    window.addEventListener(BRANCH_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(BRANCH_CHANGED_EVENT, onChanged)
  }, [threadId, syncActivePath])

  // Switch the visible version of a message (the `< n/m >` control).
  const handleSwitchVersion = useCallback(
    (messageId: string, dir: -1 | 1) => {
      const msgs = useMessages.getState().getMessages(threadId)
      const target = msgs.find((m) => m.id === messageId)
      if (!target) return
      const siblings = getSiblings(msgs, target)
      const idx = siblings.findIndex((m) => m.id === messageId)
      const next = siblings[idx + dir]
      if (!next) return
      titleAbortRef.current?.abort()
      titleAbortRef.current = null
      clearBannerErrors()
      setActiveBranch(next)
      syncActivePath()
    },
    [threadId, setActiveBranch, syncActivePath, clearBannerErrors]
  )

  // Resolve the user message that an assistant reply hangs off of.
  const resolveAssistantParent = useCallback(
    (messageId: string | undefined): string | null => {
      const activeRootId = (
        useThreads.getState().threads[threadId]?.metadata as
          | Record<string, unknown>
          | undefined
      )?.activeRootId as string | undefined
      return resolveAssistantParentIn(
        useMessages.getState().getMessages(threadId),
        activeRootId,
        messageId
      )
    },
    [threadId]
  )

  // What the quit path needs to save a reply that is still streaming the way
  // onFinish would: the stopped turn it continues and the turn it answers.
  useEffect(() => {
    if (!threadId) return
    return registerReplyContext(threadId, () => ({
      continueReplaceId: continueReplaceIdRef.current,
      parentId:
        pendingAssistantParentId.current ?? resolveAssistantParent(undefined),
    }))
  }, [threadId, resolveAssistantParent])

  // Regenerate keeps the previous reply as a prior version (no deletion); the
  // new reply arrives in onFinish as a sibling and becomes the active branch.
  // Fork this chat from a message into a new chat, and open it.
  const handleFork = useCallback(
    async (messageId: string) => {
      if (!threadId) return
      // A message off the shown branch fails here instead of forking another
      // branch in its place.
      const forkedId = await forkThread(threadId, messageId).catch(() => null)
      if (!forkedId) {
        toast.error(t('chat:fork.failed'))
        return
      }
      toast.success(t('chat:fork.done'))
      navigate({ to: route.threadsDetail, params: { threadId: forkedId } })
    },
    [threadId, navigate, t]
  )

  // Stable identity, latest closure: MessageItem's memo ignores callback
  // props, so a row that skipped a render must still see the current
  // `contextLimitError` when its Regenerate is clicked.
  const handleRegenerate = useLatestCallback(
    (messageId?: string) => {
      const hadBannerError =
        useAppState.getState().oomError != null ||
        useAppState.getState().backendError != null ||
        contextLimitError != null
      if (useAppState.getState().oomError) {
        useAppState.getState().setOomError(undefined)
      }
      if (useAppState.getState().backendError) {
        useAppState.getState().setBackendError(undefined)
      }
      if (contextLimitError) setContextLimitError(null)
      if (hadBannerError) stripBannerMetadata()
      titleAbortRef.current?.abort()
      titleAbortRef.current = null

      ensureBranched()
      pendingAssistantParentId.current = resolveAssistantParent(messageId)

      regenerate(messageId ? { messageId } : undefined)
    }
  )

  // The handlers passed to every MessageItem read the transcript through a
  // ref: depending on `chatMessages` gave them a new identity on every
  // streamed delta, which defeated MessageItem's memo and re-rendered the
  // whole transcript per delta.
  const chatMessagesRef = useRef(chatMessages)
  chatMessagesRef.current = chatMessages

  // Resume a turn that was stopped before it finished: replay the partial text
  // as an assistant prefill so the model continues from where it left off. The
  // transport re-emits the partial as the first delta, so the regenerated
  // message reconstitutes partial + new content and the KV cache is reused.
  const handleContinue = useCallback(
    (messageId: string) => {
      const msg = chatMessagesRef.current.find((m) => m.id === messageId)
      if (!msg) return
      const content = partialOf(msg)
      if (!hasPartial(content)) return
      setContinueFromContent(content)
      continueReplaceIdRef.current = messageId
      handleRegenerate(messageId)
    },
    [setContinueFromContent, handleRegenerate]
  )

  // Editing forks a new sibling version (the original + its subtree are kept).
  // User edits regenerate a reply for the new branch; assistant edits don't.
  const handleEditMessage = useCallback(
    (messageId: string, newText: string) => {
      const msgs = ensureBranched()
      const target = msgs.find((m) => m.id === messageId)
      if (!target) return

      useMessageErrors.getState().clearError(messageId)
      titleAbortRef.current?.abort()
      titleAbortRef.current = null

      const newId = generateId()
      const sibling = makeSibling(target, {
        id: newId,
        createdAt: Date.now(),
        text: newText,
      })
      addMessage(sibling)
      setActiveBranch(sibling)

      if (target.role === 'user') {
        pendingAssistantParentId.current = newId
        syncActivePath()
        regenerate({ messageId: newId })
      } else {
        syncActivePath()
      }
    },
    [
      ensureBranched,
      addMessage,
      setActiveBranch,
      syncActivePath,
      regenerate,
    ]
  )

  // Handle delete message
  // A paired phone regenerates and edits through these same handlers.
  useRemoteChatActions(threadId, { regenerate: handleRegenerate, edit: handleEditMessage })

  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      // Re-link what hangs below the message before it goes. Deleting only the
      // row stranded its children behind a parent that no longer existed, and
      // the rest of the conversation disappeared from view (janhq/jan#8495).
      const stored = useMessages.getState().getMessages(threadId)
      const branched = hasBranching(stored)
      for (const m of removeFromTree(stored, [messageId])) updateMessage(m)
      repairActiveRoot(threadId, stored, [messageId])
      deleteMessage(threadId, messageId)
      useMessageErrors.getState().clearError(messageId)

      if (branched) {
        syncActivePath()
        return
      }
      // Update chat messages for UI
      const updatedChatMessages = chatMessagesRef.current.filter(
        (msg) => msg.id !== messageId
      )
      setChatMessages(updatedChatMessages)
    },
    [
      threadId,
      deleteMessage,
      updateMessage,
      syncActivePath,
      setChatMessages,
    ]
  )

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

  /**
   * Compact this conversation now (`/compact`, the context banner's Compact
   * button). The summary is kept with the thread and every later request
   * sends it in place of the older messages; the divider marks where.
   */
  const [compacting, setCompacting] = useState(false)
  const handleCompact = async (
    opts: { thenRegenerate?: boolean; focus?: string } = {}
  ) => {
    if (compacting || status === 'streaming' || status === 'submitted') return
    setCompacting(true)
    const before = readChatCompaction(threadId)
    try {
      const record = await compactNow(chatMessages, opts.focus)
      if (!record) {
        toast.info(t('common:budget.compactFailed'))
        return
      }
      toast.success(
        t('common:budget.compactDone', { model: record.model ?? '' }),
        {
          action: {
            label: t('common:budget.compactUndo'),
            onClick: () => {
              // Messages are kept whole in Chat; undoing forgets the summary
              // so requests send the full history again. Only while it is
              // still this compaction in force.
              if (readChatCompaction(threadId)?.record.at !== record.at) {
                toast.info(t('common:budget.compactUndoStale'))
                return
              }
              writeChatCompaction(threadId, before)
            },
          },
        }
      )
      // From the context banner: the request failed for room, so it is sent
      // again on the room compaction freed.
      if (opts.thenRegenerate) handleRegenerate()
    } catch (e) {
      console.warn('[chat] compaction failed', e)
      toast.error(
        e instanceof CompactionSummaryError
          ? t('common:budget.compactFailedReason', { reason: e.reason })
          : t('common:budget.compactFailed')
      )
    } finally {
      setCompacting(false)
    }
  }
  const handleCompactRef = useRef(handleCompact)
  handleCompactRef.current = handleCompact
  // A reply cut off by the window filling: compact, then continue it from the
  // partial text. Nothing caps how often this can happen in one run -- each
  // pass has to fold something, and when nothing is left to fold the banner
  // takes over -- so the window is the only limit.
  recoverContextLimitRef.current = async (message, partial) => {
    try {
      const policy = await getCompactionPolicy()
      const params = thread?.assistants?.[0]?.parameters as
        | Record<string, unknown>
        | undefined
      if (
        !resolveAutoCompact(params, policy.auto) ||
        policy.strategy !== 'summarize'
      ) {
        return false
      }
      // Without the partial reply: it is regenerated below, and a summary
      // boundary on a message that is about to be replaced would be lost.
      const record = await compactNow(
        chatMessagesRef.current.filter((m) => m.id !== message.id)
      )
      if (!record) return false
      if (hasPartial(partial)) {
        setContinueFromContentRef.current?.(partial)
        setPendingContinueMessage(message)
      }
      handleRegenerate()
      return true
    } catch (e) {
      console.warn('[chat] compaction after the window filled failed', e)
      return false
    }
  }
  useEffect(
    () =>
      registerChatCompactor(threadId, (focus) =>
        handleCompactRef.current({ focus })
      ),
    [threadId]
  )
  // `/btw <question>`: answered from a snapshot, shown in a toast, never
  // added to the thread; reads a copy so it also works while a reply streams.
  const sideQuestionRef = useRef(sideQuestion)
  sideQuestionRef.current = sideQuestion
  useEffect(
    () =>
      registerChatSideQuestion(threadId, async (question) => {
        try {
          const answer = await sideQuestionRef.current(
            chatMessagesRef.current,
            question
          )
          if (!answer) throw new Error('no answer')
          toast.info(`/btw ${question}`, {
            description: answer,
            duration: 60_000,
            closeButton: true,
          })
        } catch (e) {
          console.warn('[chat] side question failed', e)
          toast.error(t('common:budget.btwFailed'))
        }
      }),
    [threadId, t]
  )
  // The compaction in force, drawn at its boundary unless the reply after it
  // already carries it.
  const compactionInForce = readChatCompaction(threadId)
  const compactionShownOnReply =
    !!compactionInForce &&
    chatMessages.some(
      (m) =>
        (m.metadata as { compaction?: { at?: number } } | undefined)
          ?.compaction?.at === compactionInForce.record.at
    )

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

  // Message queue: auto-send the next queued message when the stream finishes.
  // No reactive subscription to the queue here — ChatInput owns the UI.
  // We only read the store imperatively when status transitions to 'ready'.
  const processingQueueRef = useRef(false)

  // If streaming errors out, hold what is queued -- the way Cowork does -- for
  // the user to send or discard: it was typed for a run that failed, and
  // neither dropping it nor sending it on its own is right. Declared before the
  // sender below so the hold lands first in the same commit.
  useEffect(() => {
    if (status === 'error') {
      useMessageQueue.getState().holdQueue(threadId)
    }
  }, [status, threadId])

  // Released (Send on a held chip) or newly queued messages. Read so the
  // sender below runs when the user releases one after an error, when the
  // status does not change.
  // Counted only while the chat can send: a message queued or steered during
  // a run must not re-render this whole conversation just to bump a number
  // the sender below ignores until the run ends.
  const canSendQueued = status === 'ready' || status === 'error'
  const readyQueued = useMessageQueue((s) =>
    canSendQueued ? s.getQueue(threadId).filter((m) => !m.held).length : 0
  )

  useEffect(() => {
    if (status !== 'ready' && status !== 'error') return
    if (processingQueueRef.current) return
    if (threadBusy || sessionData.tools.length > 0) return

    const next = nextChatTurn(threadId)
    if (!next) return

    processingQueueRef.current = true
    // A phone's message queued with attachments goes through this chat's
    // composer entry, as a phone's send to an idle chat does, so its media
    // and documents go with it. This view registers that entry, so the
    // text-only fallback is only for a send racing an unmount.
    const { attachments } = next
    const sending = attachments
      ? sendQueuedViaComposer('chat', threadId, next.text, attachments).then(
          (sent) => (sent ? undefined : sendQueuedMessage(next.text, false))
        )
      : sendQueuedMessage(next.text, next.steered)
    sending
      .catch((err) => {
        console.error('Failed to send queued message:', err)
      })
      .finally(() => {
        processingQueueRef.current = false
      })
  }, [
    status,
    threadId,
    sendQueuedMessage,
    sessionData.tools.length,
    threadBusy,
    readyQueued,
  ])

  // Attach the error to the assistant turn it belongs to so the banner renders
  // alongside any tool-call parts the model already produced. Falls back to the
  // last user message if no assistant message exists yet (e.g. provider 4xx
  // before streaming starts).
  useEffect(() => {
    if (!error) return
    let targetId: string | undefined
    let lastUserIdx = -1
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === 'user') {
        lastUserIdx = i
        break
      }
    }
    for (let i = chatMessages.length - 1; i > lastUserIdx; i--) {
      if (chatMessages[i].role === 'assistant') {
        targetId = chatMessages[i].id
        break
      }
    }
    if (!targetId && lastUserIdx >= 0) {
      targetId = chatMessages[lastUserIdx].id
    }
    if (!targetId) return
    const errMessage =
      error instanceof Error
        ? describeChatFailure(error, selectedProvider)
        : String(error || 'Error')
    // Context overflow is owned by the global "Increase Context Size" banner;
    // a per-message Regenerate would just re-overflow the same prompt.
    if (isContextOverflowMessage(errMessage)) {
      stampContextErrorOnThread(threadId, errMessage)
      setContextLimitError(new Error(errMessage))
      useMessageErrors.getState().clearError(targetId)
      return
    }
    useMessageErrors.getState().setError(targetId, errMessage)
    const tm = useMessages.getState().getMessages(threadId).find(
      (m) => m.id === targetId
    )
    if (tm) {
      const existingError = (tm.metadata as Record<string, unknown> | undefined)
        ?.error
      if (existingError !== errMessage) {
        updateMessage({
          ...tm,
          metadata: { ...(tm.metadata || {}), error: errMessage },
        })
      }
    }
  }, [status, error, threadId, chatMessages, updateMessage, selectedProvider])

  // Persist whenever the user message lands in useMessages — covers the race
  // where the stamping effect ran before addMessage's commit was observable.
  const localThreadMessages = useMessages((s) => s.messages?.[threadId])
  const errorEntries = useMessageErrors((s) => s.errors)
  useEffect(() => {
    if (!localThreadMessages) return
    for (const m of localThreadMessages) {
      const err = errorEntries[m.id]
      if (typeof err !== 'string' || !err) continue
      const existing = (m.metadata as Record<string, unknown> | undefined)
        ?.error
      if (existing === err) continue
      updateMessage({
        ...m,
        metadata: { ...(m.metadata || {}), error: err },
      })
    }
  }, [localThreadMessages, errorEntries, updateMessage])

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

  // The Details inspector ("What Flint is using"). On a narrow pane it takes the
  // whole width and a switch moves between it and the conversation; the
  // conversation stays mounted, so its draft and scroll survive.
  // Open beside the conversation on a wide window, as the design shows it;
  // the last choice is remembered. A narrow window starts on the
  // conversation, since there the inspector takes the whole width.
  const [detailsOpen, setDetailsOpen] = useState(() => readDetailsOpen(isSplit))
  const [narrowView, setNarrowView] = useState<'conversation' | 'details'>(
    'conversation'
  )
  const detailsPanelId = useId()
  // A phone's page header has room for one button (see controlsWith).
  const isPhone = useMediaQuery('(max-width: 639px)')
  // The split pane's title fades only when it is too long to fit.
  const titleRef = useRef<HTMLHeadingElement>(null)
  useTextOverflow(titleRef)
  // Splitting halves the width; the inspector gives its room to the panes.
  useEffect(() => {
    if (isSplit) {
      setDetailsOpen(false)
      setNarrowView('conversation')
    }
  }, [isSplit])
  const toggleDetails = useCallback(() => {
    const next = !detailsOpen
    setDetailsOpen(next)
    setNarrowView(next ? 'details' : 'conversation')
    writeDetailsOpen(next)
  }, [detailsOpen])
  const closeDetails = useCallback(() => {
    setDetailsOpen(false)
    setNarrowView('conversation')
    writeDetailsOpen(false)
  }, [])

  // Who this conversation is: the title, on the chat frame's header row.
  const identity = (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <Icon name="comment" size={16} />
      <h1
        ref={titleRef}
        data-testid="conversation-title"
        // In a split pane the title fades out, as the sidebar's do, and the
        // pane being worked in has it in the foreground colour. text-fade is
        // added after cn(): tailwind-merge takes it for a text colour and
        // would drop it.
        className={
          cn(
            'min-w-0 text-sm leading-none font-medium',
            isSplit ? 'flex-1' : 'truncate',
            isSplit && isActive
              ? 'text-foreground'
              : 'text-secondary-foreground'
          ) + (isSplit ? ' text-fade' : '')
        }
        title={plainThreadTitle}
      >
        {plainThreadTitle}
      </h1>
      {threadId !== TEMPORARY_CHAT_ID && <ChatFoldersChip threadId={threadId} />}
    </div>
  )

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
  const groupLabel = thread?.isFavorite
    ? t('common:shell.pinned')
    : thread?.metadata?.project?.name
  // The mark sits in its own non-shrinking box with a little padding, so the
  // header slot's overflow clip never cuts into the dot's left edge.
  const statusMark =
    threadStatus !== 'none' ? (
      <span
        data-testid="header-thread-status"
        className="flex shrink-0 items-center px-0.5"
      >
        <ThreadStatusMark status={threadStatus} />
      </span>
    ) : null
  const projectChip = (
    <>
      {groupLabel && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Chip className="hidden max-w-48 md:inline-flex">
              <span className="truncate">{groupLabel}</span>
            </Chip>
          </TooltipTrigger>
          <TooltipContent>{groupLabel}</TooltipContent>
        </Tooltip>
      )}
    </>
  )

  // When the conversation began: its first message's time.
  const firstCreatedAt = (
    chatMessages[0]?.metadata as { createdAt?: Date | string } | undefined
  )?.createdAt

  // What acts on the conversation, plus whatever the surrounding layout adds.
  // The model sits under the composer (on a phone, on the conversation's own
  // header row).
  const buildExportDoc = ({ allVersions }: { allVersions: boolean }) =>
    docFromThread(
      thread ?? { id: threadId },
      useMessages.getState().getMessages(threadId),
      new Date(),
      { allVersions }
    )
  const controlsWith = (extra: ReactNode) => (
    <>
      <TemporaryChatBanner threadId={threadId} />
      {/* On a phone the page header has room for one button: Split and Details
          move into an overflow menu. A split pane's header row keeps them all. */}
      <div className="flex shrink-0 items-center gap-1.5">
        {extra && <div className="hidden sm:contents">{extra}</div>}
        {!isSplit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                className="size-[30px] sm:hidden pointer-coarse:size-11"
                aria-label={t('common:more')}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={toggleDetails}>
                <PanelRight className="size-4" />
                <span>{t('context:details')}</span>
              </DropdownMenuItem>
              <ExportSubmenu
                build={buildExportDoc}
                versions
                extra={<SaveChatPicturesItem threadId={threadId} />}
              />
              {extra && (
                <DropdownMenuItem
                  onSelect={() => useSplitConversation.getState().addPane()}
                >
                  <Columns2 className="size-4" />
                  <span>{t('chat:split.open')}</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {!isSplit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                className="size-[30px] max-sm:hidden"
                aria-label={t('common:export.header')}
                data-testid="export-thread-header"
              >
                <Download className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <ExportItems
                build={buildExportDoc}
                versions
                extra={<SaveChatPicturesItem threadId={threadId} />}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <WhatJanIsUsingToggle
          open={detailsOpen}
          onToggle={toggleDetails}
          controls={detailsPanelId}
          className={isSplit ? '[&>span]:sr-only' : 'max-sm:hidden'}
        />
      </div>
    </>
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
    <PathRootsContext.Provider value={chatPathRoots}>
    <WidgetHostContext.Provider value={widgetHost}>
    <ChatPaneDropZone
      className={cn(
        'flex h-full min-h-0 flex-col',
        // The page's own breathing room; a split pane sits flush in its half.
        !isSplit && 'px-1 pt-3.5 pb-4'
      )}
    >
      {!isSplit && (
        <HeaderPage>
          {/* The collection, then the model and the controls that act on
              the conversation. The breadcrumb already names the chat. */}
          <div className="flex w-full min-w-0 items-center gap-1.5 md:pr-1">
            {statusMark}
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {projectChip}
            </div>
            {controlsWith(contextControls)}
          </div>
        </HeaderPage>
      )}
      <div
        ref={findRootRef}
        className="@container/conv relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {detailsOpen && (
          // Narrow panes show one of the two at a time.
          <div className="shrink-0 pb-2 @3xl/conv:hidden">
            <div
              role="group"
              aria-label={t('context:views.label')}
              data-testid="conversation-view-switch"
              className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-0.5 shadow-[inset_0_0_0_0.8px_var(--border)]"
            >
              {(['conversation', 'details'] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  aria-pressed={narrowView === view}
                  onClick={() => setNarrowView(view)}
                  className={cn(
                    'flex h-7 min-w-0 items-center justify-center rounded-md px-2 text-xs font-medium transition-colors outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11',
                    narrowView === view
                      ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <span className="truncate">{t(`context:views.${view}`)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 gap-4">
        {/* The conversation is one Frame: its title row, then the messages
            and the composer on the card inside. */}
        <Frame
          className={cn(
            'h-full min-h-0 min-w-0 flex-1',
            // The pane being worked in: its hairline in the ring colour.
            isSplit &&
              isActive &&
              ACTIVE_PANE_RING,
            detailsOpen &&
              narrowView === 'details' &&
              '@max-3xl/conv:invisible'
          )}
        >
          <FrameHeader
            data-testid={
              isSplit ? `conversation-pane-header-${paneId}` : undefined
            }
            data-active={isSplit ? isActive : undefined}
            className="min-h-9"
          >
            {identity}
            {isSplit ? (
              <div className="flex min-w-0 shrink items-center gap-1.5">
                {controlsWith(paneControls)}
              </div>
            ) : (
              <>
                {isPhone && (
                  <div className="min-w-0 shrink">
                    <DropdownModelProvider model={threadModel} />
                  </div>
                )}
                {firstCreatedAt && (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums max-sm:hidden">
                    {t('chat:startedAt', {
                      time: formatMessageTime(firstCreatedAt),
                    })}
                  </span>
                )}
              </>
            )}
          </FrameHeader>
          <FrameBody className="min-h-0 overflow-hidden">
        {/* Messages Area */}
        <div
          className="message-zoom flex-1 relative min-w-0"
          style={
            {
              '--font-size-base': `calc(var(--app-font-base, ${fontSize}) * ${messageZoom})`,
            } as CSSProperties
          }
        >
          {/* Inside the chat column, so it never covers the Details panel. */}
          {findOpen && isActive && !findWaitsForOther && (
            <ConversationFindBar
              messages={chatMessages}
              root={() => findRootRef.current}
              seed={findSeed}
              onClose={() => useConversationFind.getState().setOpen(false)}
              reveal={revealMessageId}
              renderedFrom={messageWindow.start}
            />
          )}
          {/* 13.5px at the default size; the message zoom scales it. */}
          <Conversation
            contextRef={stickRef}
            className="absolute inset-0 text-start text-[calc(var(--text-base)*0.84375)] leading-[1.6] text-fg-2"
          >
            <ConversationContent
              className={cn(
                'transcript-list mx-auto w-full min-w-0 max-w-[calc(780px+2.5rem)] pt-[22px] pb-4',
                isSplit ? 'px-4' : 'px-5'
              )}
            >
              {messageWindow.hasEarlier && (
                <ConversationLoadEarlier
                  hidden={messageWindow.start}
                  onLoad={messageWindow.loadEarlier}
                />
              )}
              {chatMessages.slice(messageWindow.start).map((message, i) => {
                const index = messageWindow.start + i
                const isLastMessage = index === chatMessages.length - 1
                const isFirstMessage = index === 0
                // A banner error stands in for the failed assistant turn:
                // regenerate/reload restarts it from scratch, so hide the
                // partial (tool calls, "Worked for Ns") and show only the banner.
                // A context-limit stop keeps its partial: that text was generated
                // and stored, and the banner only offers a bigger window.
                if (
                  isLastMessage &&
                  (oomError || backendError) &&
                  message.role === 'assistant'
                )
                  return null
                return (
                  <Fragment key={message.id}>
                    {compactionInForce &&
                    !compactionShownOnReply &&
                    compactionInForce.boundaryId === message.id ? (
                      <CompactionDivider record={compactionInForce.record} />
                    ) : null}
                    <MessageItem
                      message={message}
                      isFirstMessage={isFirstMessage}
                      isLastMessage={isLastMessage}
                      status={effectiveStatus}
                      versionInfo={versionInfoById[message.id]}
                      view={{
                        switchedFrom: switchedFromOf(chatMessages, index),
                        isAnimating: !pendingContinueMessage,
                        hideActions: !!pendingContinueMessage,
                      }}
                      reasoning={{
                        containerRef: reasoningContainerRef,
                        isAtBottom: isReasoningAtBottom,
                        onScroll: handleReasoningScroll,
                        onScrollToBottom: forceScrollReasoningToBottom,
                      }}
                      actions={{
                        onRegenerate: handleRegenerate,
                        onFork: handleFork,
                        onContinue: handleContinue,
                        onEdit: handleEditMessage,
                        onDelete: handleDeleteMessage,
                        onSwitchVersion: handleSwitchVersion,
                      }}
                    />
                  </Fragment>
                )
              })}
              {compacting && <CompactingIndicator />}
              {pendingContinueMessage && status === 'submitted' && (
                <MessageItem
                  key={`continue-placeholder-${pendingContinueMessage.id}`}
                  message={pendingContinueMessage}
                  isFirstMessage={false}
                  isLastMessage={true}
                  status={effectiveStatus}
                  view={{
                    hideActions: true,
                    isAnimating: false,
                  }}
                  reasoning={{
                    containerRef: reasoningContainerRef,
                    isAtBottom: isReasoningAtBottom,
                    onScroll: handleReasoningScroll,
                    onScrollToBottom: forceScrollReasoningToBottom,
                  }}
                  actions={{
                    onRegenerate: handleRegenerate,
                    onEdit: handleEditMessage,
                    onDelete: handleDeleteMessage,
                  }}
                />
              )}
              {memoryLocation && (
                <MemoryProposalList
                  className="my-2"
                  proposals={memoryProposals}
                  location={memoryLocation}
                  onResolved={onMemoryProposalResolved}
                  onOpenSettings={() =>
                    navigate({ to: route.settings.memory })
                  }
                  projectName={thread?.metadata?.project?.name}
                />
              )}
              {processingEmbeddings && (
                <div
                  role="status"
                  className="flex items-start gap-3 px-3.5 py-3 my-2 rounded-xl border-[0.8px] border-border bg-card"
                >
                  <Loader2 className="size-4 text-muted-foreground shrink-0 mt-0.5 motion-safe:animate-spin" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground mb-0.5">
                      {t('chat:embeddings.title')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('chat:embeddings.description')}
                    </p>
                  </div>
                </div>
              )}
              {!oomError &&
                !backendError &&
                !contextLimitError &&
                status === CHAT_STATUS.SUBMITTED && (
                <div className="flex flex-row items-center gap-2">
                  {pendingContinueMessage && (
                    <Shimmer duration={1}>{t('chat:growingTheMind')}</Shimmer>
                  )}
                  {!pendingContinueMessage && !lastIsAssistant && (
                    <PromptProgress status={modelWaitStatus()} />
                  )}
                </div>
              )}
              {!oomError &&
                !backendError &&
                !contextLimitError &&
                status === CHAT_STATUS.STREAMING &&
                quietSince !== null && (
                <div className="flex flex-row items-center gap-2">
                  <PromptProgress
                    status={modelWaitStatus(true)}
                    since={quietSince}
                  />
                </div>
              )}
              {(contextLimitError || oomError || backendError) && (
                <ConversationErrorNotice
                  oomError={oomError}
                  backendError={backendError}
                  contextLimitError={contextLimitError}
                  error={error}
                  contextBannerMessage={contextBannerMessage}
                  compacting={compacting}
                  selectedProvider={selectedProvider}
                  handleCompact={handleCompact}
                  handleContextSizeIncrease={handleContextSizeIncrease}
                  handleRegenerate={handleRegenerate}
                />
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        </div>

        {/* Chat Input - Fixed at bottom. The shell sizes the page to the
            visual viewport, so this stays above a phone keyboard. A short
            fade above it lets the transcript slide under the composer. */}
        <div
          className={cn(
            'relative mx-auto w-full min-w-0 max-w-[calc(780px+2rem)] pt-2.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]',
            "before:pointer-events-none before:absolute before:inset-x-0 before:-top-9 before:z-10 before:h-9 before:bg-linear-to-b before:from-transparent before:to-card before:content-['']",
            isSplit ? 'px-3' : 'px-4'
          )}
        >
          {/* Approvals a subagent raises have no tool card to sit under. */}
          <FolderTrustBanner folder={chatPathRoots[0] ?? null} />
          <CoworkChildApprovals sessionId={threadId} />
          <ChatTasks threadId={threadId} />
          {currentHistoryError ? (
            <div role="alert" className="rounded-lg border p-4">
              <p>
                {t('common:historyReadFailed', {
                  defaultValue: 'Unable to load conversation history.',
                })}
              </p>
              <p className="text-sm text-muted-foreground">
                {currentHistoryError}
              </p>
              <Button
                disabled={isReadingHistory}
                onClick={() => setHistoryReadAttempt((n) => n + 1)}
                className="mt-2"
              >
                {t('common:run.tryAgain')}
              </Button>
            </div>
          ) : (
          <ChatInput
            model={threadModel}
            // Under the composer, as in Cowork. A phone keeps it in the header.
            modelControl={
              isPhone && !isSplit ? undefined : (
                <DropdownModelProvider variant="quiet" model={threadModel} />
              )
            }
            groupOptions
            onSubmit={handleSubmit}
            onStop={() => {
              // Stop is for the whole turn: subagents it started, and a tool
              // call still running, whose cancelled result must not be sent
              // back to the model for another reply.
              stopChatTurn({
                toolAbort: toolCallAbortController,
                stopDelegation: () => stopChatDelegation(threadId),
                stopStream: stop,
                cancelToolCall: () => useAppState.getState().cancelToolCalls?.[threadId]?.(),
              })
            }}
            chatStatus={effectiveStatus}
            // Named, not inferred from the current thread: in a split the
            // current thread is the other pane half the time.
            threadId={threadId}
            draftScope={paneDraftScope(paneId)}
            takeFocus={isActive}
            surfaceControls={
              workProfilesOn ? (
                <ChatWorkProfilePicker threadId={threadId} />
              ) : undefined
            }
          />
          )}
        </div>
          </FrameBody>
        </Frame>
        <WhatJanIsUsingPanel
          id={detailsPanelId}
          threadId={threadId}
          messages={chatMessages}
          open={detailsOpen}
          onClose={closeDetails}
          className={cn(
            'w-(--inspector-w) shrink-0',
            '@max-3xl/conv:absolute @max-3xl/conv:inset-0 @max-3xl/conv:z-10 @max-3xl/conv:w-full',
            narrowView === 'conversation' && '@max-3xl/conv:hidden'
          )}
        />
        </div>
      </div>
    </ChatPaneDropZone>
    </WidgetHostContext.Provider>
    </PathRootsContext.Provider>
  )
}
