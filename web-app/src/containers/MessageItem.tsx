import { useSecondClock } from '@/lib/sharedClock'
import { memo, useState, useCallback, useMemo } from 'react'
import type { UIMessage, ChatStatus } from 'ai'
import { hasRawToolCall } from '@/lib/rawToolCallText'
import { EnableToolsCard } from '@/containers/message/EnableToolsCard'
import { useModelToolsEnabled, useThreadToolGrants } from '@/hooks/useThreadToolGrants'
import { enableModelCapabilities } from '@/lib/modelCapabilityEnable'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/utils'
import {
  subagentActivityLabel,
  usedSkillNames,
  type ActivityLabel,
} from '@/lib/agentActivity'
import type { SubagentRun } from '@/types/coworkSession'
import { Loader, RefreshCw, TriangleAlert } from 'lucide-react'

import { ChainOfThoughtGroup } from './message/ChainOfThoughtGroup'
import { AssistantMessageHeader } from './message/AssistantMessageHeader'
import { MessageContextMenu } from './message/MessageContextMenu'
import {
  AssistantMessageActions,
  UserMessageActions,
} from './message/MessageActionBars'
import {
  renderMessageFilePart,
  renderMessageTextPart,
} from './message/renderMessageParts'
import { useMessageCitations } from './message/useMessageCitations'
import {
  attachedFilesOf,
  awaitsApproval,
  copyTextOf,
  hasPendingToolPart,
  imageUrlsOf,
  userImagesOf,
} from '@/lib/messageParts'
import { VersionSwitcher } from './message/VersionSwitcher'
import { shouldAnimateEntry } from '@/lib/messageEntry'
import {
  CHAT_STATUS,
  CONTENT_TYPE,
  type MessagePartLike,
  type PartEntry,
} from './message/types'
import { thoughtSecondsFromMetadata } from '@/lib/reasoningClock'
import { docFromUIMessage } from '@/lib/exportDoc'
import { calledUnavailableTool, emptyRunFallback } from '@/lib/emptyRunFallback'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { toast } from 'sonner'
import { copyToClipboard } from '@/lib/clipboard'
import { toMs } from '@/lib/messageTime'
import {
  useConversationModel,
  useConversationPane,
} from '@/hooks/useConversationPane'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useMessageErrors } from '@/stores/message-errors'
import { Button } from '@/components/ui/button'
import { PromptProgress } from '@/components/PromptProgress'
import { modelWaitStatus } from '@/lib/runStatus'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { WebSourcesRow } from '@/components/WebSourcesRow'
import { attributionOf } from '@/lib/requestAttribution'
import { CompactionDivider } from '@/containers/CompactionDivider'
import { AttachedImages } from '@/components/AttachedImages'
import { ImageViewer, type ViewerImage } from '@/components/ImageViewer'
import type { CompactionRecord } from '@/lib/compaction'
import { ReplyCutOff } from '@/components/ReplyCutOff'

/** How the row is drawn. */
export type MessageItemView = {
  isAnimating?: boolean
  hideActions?: boolean
  /** Cowork only: keep completed tool calls in the conversation. AH-172. */
  keepToolActivity?: boolean
  /**
   * Cowork only: this row continues the assistant message above it (a later
   * model round of the same reply), so it carries no header of its own.
   */
  continuation?: boolean
  /**
   * Chat only: the assistant that answered the message before this one, when
   * it is a different one. Sets this reply apart with a rule above it.
   */
  switchedFrom?: string
  /**
   * Cowork only: more of the same reply follows this row (a later model
   * round). The row is not the end of the run, so it gets no empty-run
   * fallback and no token-speed line of its own.
   */
  midReply?: boolean
  /**
   * Cowork only: every part of the whole reply when this row is one round of
   * it, so the no-reply fallback judges the run and not the round.
   */
  runParts?: UIMessage['parts']
}

/** The shared reasoning pane's scroll state, owned by the transcript. */
export type MessageItemReasoning = {
  containerRef?: React.RefObject<HTMLDivElement | null>
  isAtBottom?: boolean
  onScroll?: () => void
  onScrollToBottom?: () => void
}

/** What the row's action buttons do. */
export type MessageItemActions = {
  onRegenerate?: (messageId: string) => void
  /** Fork the conversation into a new chat that starts at this message. */
  onFork?: (messageId: string) => void
  onContinue?: (messageId: string) => void
  onEdit?: (messageId: string, newText: string) => void
  onDelete?: (messageId: string) => void
  onSwitchVersion?: (messageId: string, dir: -1 | 1) => void
}

/*
 * The grouped objects are usually written inline by the caller, so they are
 * new on every render. The memo comparator below reads the fields of `view`
 * one by one and, as before the grouping, ignores `reasoning` and `actions`:
 * a fresh object never re-renders a settled row.
 */
export type MessageItemProps = {
  message: UIMessage
  isFirstMessage: boolean
  isLastMessage: boolean
  status: ChatStatus
  versionInfo?: { index: number; count: number }
  // Cowork only: the session's background subagent runs. Omitted in regular
  // chat threads, which never spawn subagents.
  subagents?: SubagentRun[]
  view?: MessageItemView
  reasoning?: MessageItemReasoning
  actions?: MessageItemActions
}

const NO_VIEW: MessageItemView = {}

export const MessageItem = memo(
  ({
    message,
    isFirstMessage,
    isLastMessage,
    status,
    subagents,
    versionInfo,
    view = NO_VIEW,
    reasoning,
    actions,
  }: MessageItemProps) => {
    const {
      isAnimating,
      hideActions,
      continuation,
      switchedFrom,
      runParts,
      midReply,
      keepToolActivity,
    } = view
    const {
      containerRef: reasoningContainerRef,
      isAtBottom: isReasoningAtBottom,
      onScroll: onReasoningScroll,
      onScrollToBottom: onReasoningScrollToBottom,
    } = reasoning ?? {}
    const { onRegenerate, onFork, onContinue, onEdit, onDelete, onSwitchVersion } =
      actions ?? {}
    const { t } = useTranslation()
    // This conversation's model, so a split pane gates on its own.
    const { selectedModel, selectedProvider } = useConversationModel()
    const getProviderByName = useModelProvider(
      (state) => state.getProviderByName
    )
    const updateProvider = useModelProvider((state) => state.updateProvider)
    // Decided once, as the message mounts: history is not animated in.
    const [animateIn] = useState(shouldAnimateEntry)
    const threadId = useConversationPane()?.threadId
    const toolsEnabled = useModelToolsEnabled(selectedModel, threadId)
    const grantThreadTools = useThreadToolGrants((s) => s.grant)
    const coloredUserBubble = useInterfaceSettings((s) => s.coloredUserBubble)
    const renderUserMarkdown = useInterfaceSettings((s) => s.renderUserMarkdown)
    const metadata = message.metadata as Record<string, unknown> | undefined
    const messageError = useMessageErrors((s) => s.errors[message.id])
    // The stored time. A message that has none yet (a reply whose first part
    // has not arrived) shows no time: "now" was re-read on every render, so
    // reopening a conversation made every such message read as just sent.
    const createdAt = toMs(metadata?.createdAt)
    // The image viewer: the images it can step through, and which is showing.
    const [viewer, setViewer] = useState<{
      images: ViewerImage[]
      index: number
    } | null>(null)
    const [ctxMenuOpen, setCtxMenuOpen] = useState(false)
    // Where the menu opens: the pointer, in the message's own coordinates. The
    // menu's anchor used to be an unpositioned sr-only span, which sat after
    // the message's content, so the menu opened at the bottom of the message
    // (and for the last one, at the very end of the transcript, under the
    // composer) instead of at the pointer.
    const [ctxPoint, setCtxPoint] = useState({ x: 0, y: 0 })

    const openContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const box = e.currentTarget.getBoundingClientRect()
      setCtxPoint({ x: e.clientX - box.left, y: e.clientY - box.top })
      setCtxMenuOpen(true)
    }, [])

    // Turn tool calls on, for this conversation or on the model itself, then
    // run the reply again now that the model can be offered its tools.
    const enableTools = (scope: 'thread' | 'always') => {
      if (scope === 'thread') {
        if (!threadId) return
        grantThreadTools(threadId)
      } else {
        if (!selectedProvider || !selectedModel) return
        const provider = getProviderByName(selectedProvider)
        if (!provider) return
        updateProvider(selectedProvider, {
          ...provider,
          models: enableModelCapabilities(provider.models, selectedModel.id, [
            'tools',
          ]),
        })
      }
      if (isLastMessage) onRegenerate?.(message.id)
    }

    const handleRegenerate = useCallback(() => {
      onRegenerate?.(message.id)
    }, [onRegenerate, message.id])

    const handleContinue = useCallback(() => {
      onContinue?.(message.id)
    }, [onContinue, message.id])

    const isStopped = metadata?.stopped === true

    const handleEdit = useCallback(
      (newText: string) => {
        onEdit?.(message.id, newText)
      },
      [onEdit, message.id]
    )

    const handleDelete = useCallback(() => {
      onDelete?.(message.id)
    }, [onDelete, message.id])

    // Get image URLs from file parts for the edit dialog
    const imageUrls = useMemo(() => imageUrlsOf(message.parts), [message.parts])

    // The images a user attached, with their names, for the gallery and viewer.
    const userImages = useMemo(
      () => userImagesOf(message.role, message.parts),
      [message.role, message.parts]
    )

    // A tool part is "pending" until it reaches a terminal state. While any
    // tool on the last assistant message is still pending the turn isn't
    // done — the model will resume once the tool result arrives, even if the
    // SDK briefly reports status as 'ready' between the tool-call stream and
    // the follow-up request.
    const hasPendingToolCall = useMemo(
      () =>
        isLastMessage &&
        message.role === 'assistant' &&
        hasPendingToolPart(message.parts),
      [isLastMessage, message.role, message.parts]
    )

    const pendingApprovals = useToolApprovalRequests((s) => s.pending)
    const awaitingApproval = useMemo(
      () =>
        hasPendingToolCall && awaitsApproval(message.parts, pendingApprovals),
      [hasPendingToolCall, message.parts, pendingApprovals]
    )

    const usedSkills = useMemo(
      () => usedSkillNames(message.parts as never),
      [message.parts]
    )

    // The activity row reports a running subagent, and only that.
    //
    // A tool call is already on screen as its own card one row above, with its
    // name, its arguments and a ticking duration, so labelling it here printed
    // the same thing twice a row apart -- the duplication the trace header was
    // trimmed for earlier. A subagent has no card: it works in a lane of its
    // own, so this is the only place its progress shows.
    // Memoized so the reference is stable for the elapsed-time interval effect.
    const activityLabel = useMemo<ActivityLabel>(() => {
      if (!subagents || subagents.length === 0) return null
      return subagentActivityLabel(subagents)
    }, [subagents])

    // Re-render once a second while a label is showing, purely to advance the
    // elapsed-time readout -- no state carried, just a tick.
    useSecondClock(!!activityLabel)

    const isStreaming =
      (isLastMessage &&
        (status === CHAT_STATUS.STREAMING ||
          status === CHAT_STATUS.SUBMITTED)) ||
      hasPendingToolCall

    // Continue is offered on a stopped reply, and on one whose run ended
    // without an answer (a tool failed and the model gave up), so the user
    // can resume the work instead of starting over.
    const canContinue =
      isStopped ||
      (message.role === 'assistant' &&
        !isStreaming &&
        !midReply &&
        emptyRunFallback((runParts ?? message.parts) as MessagePartLike[]) !==
          null)

    const { citationOffsets, webCitations, webReads, grounding } =
      useMessageCitations(message, isStreaming)

    // Extract file metadata from message text (for user messages with attachments)
    const attachedFiles = useMemo(
      () => attachedFilesOf(message.role, message.parts),
      [message.parts, message.role]
    )

    // Get full text content for copy button
    const getFullTextContent = useCallback(
      () => copyTextOf(message.role, message.parts),
      [message.parts, message.role]
    )

    const renderTextPart = (
      part: { type: 'text'; text: string },
      partIndex: number
    ) =>
      renderMessageTextPart(part, partIndex, {
        message,
        metadata,
        attachedFiles,
        coloredUserBubble,
        renderUserMarkdown,
        grounding,
        isStreaming,
        isAnimating,
        t,
      })

    const renderFilePart = (part: MessagePartLike, partIndex: number) =>
      renderMessageFilePart(part, partIndex, { message, t, setViewer })

    const persistedThoughtSeconds = thoughtSecondsFromMetadata(metadata)
    const renderedParts = useMemo(() => {
      const parts = message.parts as MessagePartLike[]
      const elements: React.ReactNode[] = []
      const isCotPart = (t: string) =>
        t === CONTENT_TYPE.REASONING || t.startsWith('tool-')

      // Walk parts sequentially and flush the reasoning/tool trace whenever a
      // non-empty answer (text/file) interrupts it, so content emitted between
      // two reasoning blocks renders as a normal message.
      let cotEntries: PartEntry[] = []
      let groupSeq = 0
      const flushCot = (hasFollowing: boolean) => {
        if (cotEntries.length === 0) return
        elements.push(
          <ChainOfThoughtGroup
            key={`${message.id}-cot-${groupSeq++}`}
            entries={cotEntries}
            messageId={message.id}
            totalParts={parts.length}
            isStreaming={isStreaming}
            hasFollowingContent={hasFollowing}
            awaitingApproval={awaitingApproval}
            keepToolActivity={keepToolActivity}
            persistedThoughtSeconds={persistedThoughtSeconds}
            citationOffsets={citationOffsets}
            reasoningContainerRef={reasoningContainerRef}
            isReasoningAtBottom={isReasoningAtBottom}
            onReasoningScroll={onReasoningScroll}
            onReasoningScrollToBottom={onReasoningScrollToBottom}
          />
        )
        cotEntries = []
      }

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const t = part.type
        if (isCotPart(t)) {
          cotEntries.push({ part, index: i })
          continue
        }
        if (t === CONTENT_TYPE.TEXT) {
          if (!part.text || part.text.trim() === '') continue
          flushCot(true)
          elements.push(
            renderTextPart(part as { type: 'text'; text: string }, i)
          )
          continue
        }
        if (t === CONTENT_TYPE.FILE) {
          flushCot(true)
          elements.push(renderFilePart(part, i))
        }
      }
      flushCot(false)
      // A run that ended after tool calls with no reply: say so, and name
      // the last tool failure, rather than leaving only the tool trace.
      // Not for a reply the user stopped: that was not the model giving up.
      if (
        message.role === 'assistant' &&
        !isStreaming &&
        !isStopped &&
        !awaitingApproval &&
        !midReply
      ) {
        const fallback = emptyRunFallback(
          (runParts ?? parts) as MessagePartLike[],
          // A failed request shows its own error below instead.
          { failed: typeof messageError === 'string' && messageError.length > 0 }
        )
        if (fallback) {
          elements.push(
            <p
              key={`${message.id}-empty-run`}
              data-testid="empty-run-fallback"
              className="mt-1 text-sm text-muted-foreground break-words"
            >
              {fallback}
            </p>
          )
        }
        // The model tried to use a tool while tool calls are off for it (a
        // call to a tool it was never offered, or one printed as text): ask
        // whether to turn them on, the way a tool approval asks.
        if (
          selectedModel &&
          !toolsEnabled &&
          (calledUnavailableTool(parts) ||
            parts.some((p) => p.type === 'text' && hasRawToolCall(p.text ?? '')))
        ) {
          elements.push(
            <EnableToolsCard
              key={`${message.id}-enable-tools`}
              modelName={selectedModel.displayName || selectedModel.id}
              onEnableThread={
                threadId ? () => enableTools('thread') : undefined
              }
              onEnableAlways={() => enableTools('always')}
            />
          )
        }
      }
      return elements
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      message.parts,
      selectedModel,
      toolsEnabled,
      threadId,
      isStreaming,
      isReasoningAtBottom,
      grounding,
      awaitingApproval,
      citationOffsets,
      midReply,
      runParts,
      isStopped,
      persistedThoughtSeconds,
    ])

    const versionNav =
      versionInfo && versionInfo.count > 1 && onSwitchVersion ? (
        <VersionSwitcher
          messageId={message.id}
          index={versionInfo.index}
          count={versionInfo.count}
          onSwitch={onSwitchVersion}
        />
      ) : null

    const compactionRecord = metadata?.compaction as
      | CompactionRecord
      | undefined

    // The model that answered, when the request recorded it.
    const answeredBy =
      message.role === 'assistant'
        ? (attributionOf(message)?.model ??
          (metadata?.model as { id?: string } | undefined)?.id)
        : undefined

    return (
      <div
        data-role={message.role}
        data-message-id={message.id}
        className={cn(
          'group/message relative mb-3 w-full',
          // A different assistant took over: a rule and some air mark the change.
          switchedFrom && 'mt-4 border-t-[0.8px] border-border pt-4',
          animateIn && 'motion-safe:animate-msg-in',
          message.role === 'user' && !isFirstMessage && 'mt-2'
        )}
        onContextMenu={openContextMenu}
      >
        {/* The request behind this reply compacted the conversation first. */}
        {message.role === 'assistant' && compactionRecord ? (
          <CompactionDivider record={compactionRecord} />
        ) : null}
        {/* A small, quiet line naming who answered and when. */}
        {message.role === 'assistant' && !continuation && (
          <AssistantMessageHeader
            avatar={
              typeof metadata?.assistantAvatar === 'string'
                ? metadata.assistantAvatar
                : undefined
            }
            name={metadata?.assistantName as string | undefined}
            answeredBy={answeredBy}
            createdAt={isStreaming ? undefined : createdAt}
          />
        )}

        {/* Render message parts */}
        {userImages.length > 0 && (
          <AttachedImages
            images={userImages}
            onOpen={(index) => setViewer({ images: userImages, index })}
          />
        )}
        {renderedParts}

        {message.role === 'assistant' &&
          !isStreaming &&
          (webCitations.length > 0 || webReads.length > 0) && (
          <WebSourcesRow citations={webCitations} readUrls={webReads} />
        )}

        {isLastMessage &&
          message.role === 'assistant' &&
          !awaitingApproval &&
          (hasPendingToolCall ||
            status === CHAT_STATUS.SUBMITTED ||
            activityLabel) && (
            <div className="mt-2">
              {activityLabel ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2 text-xs"
                >
                  <Loader className="motion-safe:animate-spin size-3.5 text-muted-foreground shrink-0" />
                  <span className="font-medium text-foreground">
                    {activityLabel.text}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatDuration(activityLabel.startedAt)}
                  </span>
                </div>
              ) : (
                <PromptProgress
                  hideIdle={hasPendingToolCall}
                  status={hasPendingToolCall ? undefined : modelWaitStatus()}
                />
              )}
            </div>
          )}

        {typeof messageError === 'string' && messageError.length > 0 && (
          <div
            role="alert"
            className="mt-2 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-destructive/30 bg-destructive-tint px-3 py-2.5 text-sm"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-destructive">
                {t('chat:messageItem.generationFailed')}
              </div>
              <div className="text-fg-2 break-words">{messageError}</div>
            </div>
            {selectedModel &&
              onRegenerate &&
              status !== CHAT_STATUS.STREAMING &&
              status !== CHAT_STATUS.SUBMITTED && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRegenerate}
                  className="shrink-0 pointer-coarse:h-11"
                >
                  <RefreshCw className="size-3.5" />
                  <span>{t('common:regenerate')}</span>
                </Button>
              )}
          </div>
        )}

        {/* Message actions for user messages */}
        {message.role === 'user' && !hideActions && (
          <UserMessageActions
            createdAt={createdAt}
            versionNav={versionNav}
            getFullTextContent={getFullTextContent}
            onEdit={onEdit}
            onDelete={onDelete}
            status={status}
            imageUrls={imageUrls}
            handleEdit={handleEdit}
            handleDelete={handleDelete}
            selectedModel={selectedModel}
            onRegenerate={onRegenerate}
            isLastMessage={isLastMessage}
            handleRegenerate={handleRegenerate}
            t={t}
          />
        )}

        {/* A reply cut at the output limit ends mid-sentence: say so (L-002). */}
        {message.role === 'assistant' &&
          !isStreaming &&
          metadata?.finishReason === 'length' && (
            <ReplyCutOff
              className="mt-1.5"
              tokens={
                (metadata.usage as { outputTokens?: number } | undefined)
                  ?.outputTokens
              }
              onContinue={
                selectedModel && onContinue && isLastMessage && canContinue
                  ? handleContinue
                  : undefined
              }
            />
          )}

        {/* Message actions for assistant messages (non-tool) */}
        {message.role === 'assistant' && !(hideActions && midReply) && (
          <AssistantMessageActions
            isStreaming={isStreaming}
            hideActions={hideActions}
            versionNav={versionNav}
            getFullTextContent={getFullTextContent}
            messageId={message.id}
            onEdit={onEdit}
            handleEdit={handleEdit}
            onDelete={onDelete}
            handleDelete={handleDelete}
            onFork={onFork}
            selectedModel={selectedModel}
            onContinue={onContinue}
            isLastMessage={isLastMessage}
            canContinue={canContinue}
            handleContinue={handleContinue}
            onRegenerate={onRegenerate}
            handleRegenerate={handleRegenerate}
            midReply={midReply}
            metadata={metadata}
            usedSkills={usedSkills}
            t={t}
          />
        )}

        {/* Right-click context menu */}
        <MessageContextMenu
          open={ctxMenuOpen}
          onOpenChange={setCtxMenuOpen}
          point={ctxPoint}
          onCopy={() => {
            // A refused write (unfocused window, no permission) says so (P2E-016).
            void copyToClipboard(getFullTextContent()).then((ok) => {
              if (!ok) toast.error(t('chat:copyMessageFailed'))
            })
          }}
          buildExport={() => docFromUIMessage(message, undefined, new Date())}
          onRegenerate={
            selectedModel && onRegenerate && !isStreaming && isLastMessage
              ? handleRegenerate
              : undefined
          }
          onContinue={
            selectedModel &&
            onContinue &&
            isLastMessage &&
            canContinue &&
            !isStreaming
              ? handleContinue
              : undefined
          }
          onDelete={onDelete && !isStreaming ? handleDelete : undefined}
        />

        {/* Image Preview Dialog */}
        {viewer && (
          <ImageViewer
            images={viewer.images}
            index={viewer.index}
            onIndexChange={(index) => setViewer((v) => (v ? { ...v, index } : v))}
            onClose={() => setViewer(null)}
          />
        )}
      </div>
    )
  },
  (prevProps, nextProps) => {
    // Always re-render if the last message is in-flight (streaming or submitted)
    if (
      nextProps.isLastMessage &&
      (nextProps.status === CHAT_STATUS.STREAMING ||
        nextProps.status === CHAT_STATUS.SUBMITTED)
    ) {
      return false
    }

    const prevView = prevProps.view ?? NO_VIEW
    const nextView = nextProps.view ?? NO_VIEW
    return (
      prevProps.message === nextProps.message &&
      prevProps.isFirstMessage === nextProps.isFirstMessage &&
      prevProps.isLastMessage === nextProps.isLastMessage &&
      prevProps.status === nextProps.status &&
      prevView.hideActions === nextView.hideActions &&
      prevView.continuation === nextView.continuation &&
      prevView.switchedFrom === nextView.switchedFrom &&
      prevView.midReply === nextView.midReply &&
      prevView.runParts === nextView.runParts &&
      prevView.keepToolActivity === nextView.keepToolActivity &&
      prevProps.versionInfo?.index === nextProps.versionInfo?.index &&
      prevProps.versionInfo?.count === nextProps.versionInfo?.count
    )
  }
)

MessageItem.displayName = 'MessageItem'
