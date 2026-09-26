/* eslint-disable @typescript-eslint/no-explicit-any */
import { memo, useState, useCallback, useEffect, useMemo } from 'react'
import { SlashInvocation } from '@/components/SlashInvocation'
import { parseSlashMarker } from '@/lib/slashCommands'
import type { UIMessage, ChatStatus } from 'ai'
import { RenderMarkdown } from './RenderMarkdown'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/utils'
import {
  subagentActivityLabel,
  usedSkillNames,
  type ActivityLabel,
} from '@/lib/agentActivity'
import type { SubagentRun } from '@/types/coworkSession'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Loader,
  Paperclip,
  Play,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * Message actions appear on hover or keyboard focus, and stay visible on a
 * touch screen, which has no hover to reveal them.
 */
const REVEAL_ACTIONS =
  'opacity-0 motion-safe:transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100'

/** Icon actions: compact with a mouse, 44px with a finger. */
const ACTION_BUTTON =
  'size-7 text-muted-foreground hover:text-foreground pointer-coarse:size-11'
import { ChainOfThoughtGroup } from './message/ChainOfThoughtGroup'
import {
  CHAT_STATUS,
  CONTENT_TYPE,
  type MessagePartLike,
  type PartEntry,
} from './message/types'
import { CopyButton } from './CopyButton'
import { emptyRunFallback } from '@/lib/emptyRunFallback'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatMessageTime } from '@/utils/formatMessageTime'
import { useConversationModel } from '@/hooks/useConversationPane'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useMessageErrors } from '@/stores/message-errors'
import { EditMessageDialog } from '@/containers/dialogs/EditMessageDialog'
import { AgentMessageHeader } from '@/containers/AgentMessageHeader'
import { DeleteMessageDialog } from '@/containers/dialogs/DeleteMessageDialog'
import TokenSpeedIndicator from '@/containers/TokenSpeedIndicator'
import { extractFilesFromPrompt, FileMetadata } from '@/lib/fileMetadata'
import { Button } from '@/components/ui/button'
import { PromptProgress } from '@/components/PromptProgress'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { parseCitationsFromToolOutput } from '@/lib/citation-parser'
import type { RagCitation, WebCitation } from '@/components/Citations'
import { useGroundingStore } from '@/stores/grounding-store'
import { useWebCitationStore } from '@/stores/web-citation-store'
import { WebSourcesRow } from '@/components/WebSourcesRow'
import { fetchedUrlOf } from '@/lib/webSources'
import { injectCitationMarkers } from '@/lib/grounding'
import { attributionOf } from '@/lib/requestAttribution'
import { FlintMark } from '@/components/shell/FlintMark'
import { CompactionDivider } from '@/containers/CompactionDivider'
import type { CompactionRecord } from '@/lib/compaction'

export type MessageItemProps = {
  message: UIMessage
  isFirstMessage: boolean
  isLastMessage: boolean
  status: ChatStatus
  reasoningContainerRef?: React.RefObject<HTMLDivElement | null>
  isReasoningAtBottom?: boolean
  onReasoningScroll?: () => void
  onReasoningScrollToBottom?: () => void
  onRegenerate?: (messageId: string) => void
  onContinue?: (messageId: string) => void
  onEdit?: (messageId: string, newText: string) => void
  onDelete?: (messageId: string) => void
  versionInfo?: { index: number; count: number }
  onSwitchVersion?: (messageId: string, dir: -1 | 1) => void
  // Cowork only: the session's background subagent runs. Omitted in regular
  // chat threads, which never spawn subagents.
  subagents?: SubagentRun[]
  isAnimating?: boolean
  hideActions?: boolean
  /** Cowork only: keep completed tool calls in the conversation. AH-172. */
  keepToolActivity?: boolean
}

export const MessageItem = memo(
  ({
    message,
    isFirstMessage,
    isLastMessage,
    status,
    isAnimating,
    hideActions,
    keepToolActivity,
    subagents,
    reasoningContainerRef,
    isReasoningAtBottom,
    onReasoningScroll,
    onReasoningScrollToBottom,
    onRegenerate,
    onContinue,
    onEdit,
    onDelete,
    versionInfo,
    onSwitchVersion,
  }: MessageItemProps) => {
    const { t } = useTranslation()
    // This conversation's model, so a split pane gates on its own.
    const { selectedModel } = useConversationModel()
    const coloredUserBubble = useInterfaceSettings((s) => s.coloredUserBubble)
    const metadata = message.metadata as Record<string, unknown> | undefined
    const messageError = useMessageErrors((s) => s.errors[message.id])
    const createdAt = (metadata?.createdAt as Date) ?? new Date()
    const [previewImage, setPreviewImage] = useState<{
      url: string
      filename?: string
    } | null>(null)
    const [ctxMenuOpen, setCtxMenuOpen] = useState(false)

    const openContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setCtxMenuOpen(true)
    }, [])

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
    const imageUrls = useMemo(() => {
      return message.parts
        .filter((part) => {
          if (part.type !== 'file') return false
          const filePart = part as {
            type: 'file'
            url?: string
            mediaType?: string
          }
          return filePart.url && filePart.mediaType?.startsWith('image/')
        })
        .map((part) => (part as { url: string }).url)
    }, [message.parts])

    // A tool part is "pending" until it reaches a terminal state. While any
    // tool on the last assistant message is still pending the turn isn't
    // done — the model will resume once the tool result arrives, even if the
    // SDK briefly reports status as 'ready' between the tool-call stream and
    // the follow-up request.
    const hasPendingToolCall = useMemo(() => {
      if (!isLastMessage || message.role !== 'assistant') return false
      return message.parts.some((part) => {
        if (!part.type?.startsWith('tool-')) return false
        const state = (part as { state?: string }).state
        return (
          state !== 'output-available' &&
          state !== 'output-error' &&
          state !== 'output-denied'
        )
      })
    }, [isLastMessage, message.role, message.parts])

    const pendingApprovals = useToolApprovalRequests((s) => s.pending)
    const awaitingApproval = useMemo(() => {
      if (!hasPendingToolCall) return false
      return message.parts.some((part) => {
        const toolCallId = (part as { toolCallId?: string }).toolCallId
        return Boolean(toolCallId && pendingApprovals[toolCallId])
      })
    }, [hasPendingToolCall, message.parts, pendingApprovals])

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
    const [, forceTick] = useState(0)
    useEffect(() => {
      if (!activityLabel) return
      const id = setInterval(() => forceTick((n) => n + 1), 1000)
      return () => clearInterval(id)
    }, [activityLabel])

    const isStreaming =
      (isLastMessage &&
        (status === CHAT_STATUS.STREAMING ||
          status === CHAT_STATUS.SUBMITTED)) ||
      hasPendingToolCall

    // Aggregate RAG citations in part order and record each rag tool part's
    // base offset, so its card numbers/anchors continue the same global
    // sequence the inline superscript markers use.
    const { ragCitations, citationOffsets, webCitations, webReads } = useMemo(() => {
      const out: RagCitation[] = []
      const web: WebCitation[] = []
      const reads: string[] = []
      const offsets = new Map<number, number>()
      if (message.role === 'assistant') {
        const parts = message.parts as any[]
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]
          if (!part.type?.startsWith('tool-')) continue
          if (part.state !== 'output-available') continue
          if (part.type === 'tool-web_fetch') {
            const url = fetchedUrlOf(part.output)
            if (url) reads.push(url)
            continue
          }
          const parsed = parseCitationsFromToolOutput(part.output)
          if (parsed?.kind === 'rag') {
            offsets.set(i, out.length)
            out.push(...parsed.citations)
          } else if (parsed?.kind === 'web') {
            web.push(...parsed.citations)
          }
        }
      }
      return {
        ragCitations: out,
        citationOffsets: offsets,
        webCitations: web,
        webReads: reads,
      }
    }, [message.parts, message.role])

    const serviceHub = useServiceHub()
    const grounding = useGroundingStore((s) => s.byMessageId[message.id])
    const ensureGrounding = useGroundingStore((s) => s.ensure)

    const assistantText = useMemo(() => {
      if (message.role !== 'assistant') return ''
      return (message.parts as any[])
        .filter((p) => p.type === CONTENT_TYPE.TEXT && p.text)
        .map((p) => p.text)
        .join('\n')
    }, [message.parts, message.role])

    useEffect(() => {
      if (isStreaming) return
      if (!assistantText || !ragCitations.length) return
      const rag = serviceHub.rag()
      if (!rag.embed) return
      ensureGrounding(
        message.id,
        assistantText,
        ragCitations,
        rag.embed.bind(rag)
      )
    }, [
      isStreaming,
      assistantText,
      ragCitations,
      message.id,
      ensureGrounding,
      serviceHub,
    ])

    const setWebCitations = useWebCitationStore((s) => s.setForMessage)
    useEffect(() => {
      if (!webCitations.length) return
      setWebCitations(message.id, webCitations)
    }, [webCitations, message.id, setWebCitations])

    // Extract file metadata from message text (for user messages with attachments)
    const attachedFiles = useMemo(() => {
      if (message.role !== 'user') return []

      const textParts = message.parts.filter(
        (part): part is { type: 'text'; text: string } =>
          part.type === CONTENT_TYPE.TEXT
      )

      if (textParts.length === 0) return []

      const { files } = extractFilesFromPrompt(textParts[0].text)
      return files
    }, [message.parts, message.role])

    // Get full text content for copy button
    const getFullTextContent = useCallback(() => {
      return message.parts
        .filter(
          (part): part is { type: 'text'; text: string } =>
            part.type === CONTENT_TYPE.TEXT
        )
        .map((part) => part.text)
        .join('\n')
    }, [message.parts])

    const renderTextPart = (
      part: { type: 'text'; text: string },
      partIndex: number
    ) => {
      if (!part.text || part.text.trim() === '') {
        return null
      }

      const isLastPart = partIndex === message.parts.length - 1

      // For user messages, extract and clean the text from file metadata
      const displayText =
        message.role === 'user'
          ? extractFilesFromPrompt(part.text).cleanPrompt
          : part.text

      // A `/command` the user sent reads as typed; the expansion folds away.
      const slashInvocation =
        message.role === 'user' ? parseSlashMarker(displayText) : null

      if (
        !displayText.trim() &&
        message.role === 'user' &&
        attachedFiles.length === 0
      ) {
        return null
      }

      return (
        <div key={`${message.id}-${partIndex}`} className="w-full">
          {message.role === 'user' ? (
            <div className="flex justify-end w-full h-full text-start wrap-break-word whitespace-normal">
              <div
                data-slot="user-bubble"
                className={cn(
                  'relative inline-block max-w-[min(85%,36rem)] rounded-[14px] rounded-br-[4px] px-3 py-2.5 text-[calc(var(--text-base)*0.8125)] leading-normal text-foreground shadow-[inset_0_0_0_0.8px_var(--border)]',
                  coloredUserBubble
                    ? // The accent tint, only when the setting asks for it.
                      'bg-acc-tint'
                    : // A neutral block otherwise: the right-aligned column
                      // and the tone are enough to find the user's own turns.
                      'bg-muted'
                )}
              >
                {/* janhq/jan#8864: typed while the agent worked and handed to
                    it mid-run, not the start of a run of its own. */}
                {metadata?.steered === true && partIndex === 0 && (
                  <div
                    data-testid="steered-label"
                    className="mb-1 text-[11px] text-muted-foreground"
                  >
                    {t('common:steering.delivered')}
                  </div>
                )}
                {partIndex === 0 && <AgentMessageHeader metadata={metadata} />}
                {/* Show attached files if any */}
                {attachedFiles.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {attachedFiles.map((file: FileMetadata, idx: number) => (
                      <div
                        key={`file-${idx}-${file.id}`}
                        className="flex min-w-0 max-w-full items-center gap-1.5 px-2 py-1 rounded-md bg-card text-foreground border-[0.8px] border-border text-xs"
                      >
                        <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate font-medium" title={file.name}>
                          {file.name}
                        </span>
                        {file.injectionMode && (
                          <span className="text-muted-foreground">
                            ({file.injectionMode})
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {displayText &&
                  (slashInvocation ? (
                    <SlashInvocation
                      invocation={slashInvocation.invocation}
                      body={slashInvocation.body}
                    />
                  ) : (
                    <div dir="auto" className="select-text whitespace-pre-wrap">
                      {displayText}
                    </div>
                  ))}
              </div>
            </div>
          ) : (
            <>
              <RenderMarkdown
                content={
                  grounding && !isStreaming
                    ? injectCitationMarkers(
                        part.text,
                        grounding.sentenceCitations,
                        `cite-${message.id}`
                      )
                    : part.text
                }
                isStreaming={isStreaming && isLastPart}
                messageId={message.id}
                isAnimating={isAnimating}
              />
            </>
          )}
        </div>
      )
    }

    const renderFilePart = (part: MessagePartLike, partIndex: number) => {
      const isImage = part.mediaType?.startsWith('image/')
      const isAudio =
        part.mediaType === 'audio/wav' || part.mediaType === 'audio/mpeg'
      const isVideo = part.mediaType?.startsWith('video/')

      if (isAudio && part.url) {
        const justify =
          message.role === 'user' ? 'justify-end' : 'justify-start'
        return (
          <div
            key={`${message.id}-${partIndex}`}
            className={`flex ${justify} w-full my-2`}
          >
            <audio controls src={part.url} className="max-w-[80%] rounded-md" />
          </div>
        )
      }

      if (isVideo && part.url) {
        const justify =
          message.role === 'user' ? 'justify-end' : 'justify-start'
        return (
          <div
            key={`${message.id}-${partIndex}`}
            className={`flex ${justify} w-full my-2`}
          >
            <video
              controls
              src={part.url}
              className="max-w-[80%] max-h-80 rounded-md border border-border"
            />
          </div>
        )
      }

      if (message.role === 'user' && isImage && part.url) {
        return (
          <div
            key={`${message.id}-${partIndex}`}
            className="flex justify-end w-full my-2"
          >
            <div className="flex flex-wrap gap-2 max-w-[80%] justify-end">
              <div className="relative">
                <img
                  src={part.url}
                  alt={part.filename || 'Uploaded attachment'}
                  className="size-20 rounded-md object-cover border border-border cursor-pointer"
                  onClick={() =>
                    setPreviewImage({ url: part.url!, filename: part.filename })
                  }
                />
              </div>
            </div>
          </div>
        )
      }

      if (message.role === 'assistant' && isImage && part.url) {
        return (
          <div key={`${message.id}-${partIndex}`} className="my-2">
            <img
              src={part.url}
              alt={part.filename || 'Generated image'}
              className="max-w-full rounded-md cursor-pointer"
              onClick={() =>
                setPreviewImage({ url: part.url!, filename: part.filename })
              }
            />
          </div>
        )
      }

      return null
    }

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
      if (message.role === 'assistant' && !isStreaming && !awaitingApproval) {
        const fallback = emptyRunFallback(parts)
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
      }
      return elements
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      message.parts,
      isStreaming,
      isReasoningAtBottom,
      grounding,
      awaitingApproval,
      citationOffsets,
    ])

    const versionNav =
      versionInfo && versionInfo.count > 1 && onSwitchVersion ? (
        <div className="flex items-center gap-0.5 text-muted-foreground">
          <button
            type="button"
            className="flex size-6 items-center justify-center rounded-md hover:bg-accent hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
            disabled={versionInfo.index <= 1}
            onClick={() => onSwitchVersion(message.id, -1)}
            title="Previous version"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="tabular-nums">
            {versionInfo.index}/{versionInfo.count}
          </span>
          <button
            type="button"
            className="flex size-6 items-center justify-center rounded-md hover:bg-accent hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
            disabled={versionInfo.index >= versionInfo.count}
            onClick={() => onSwitchVersion(message.id, 1)}
            title="Next version"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
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
        className={cn(
          'group/message mb-[18px] w-full motion-safe:animate-msg-in',
          message.role === 'user' && !isFirstMessage && 'mt-2'
        )}
        onContextMenu={openContextMenu}
      >
        {/* The request behind this reply compacted the conversation first. */}
        {message.role === 'assistant' && compactionRecord ? (
          <CompactionDivider record={compactionRecord} />
        ) : null}
        {/* A small, quiet line naming who answered and when. */}
        {message.role === 'assistant' && (
          <div
            data-testid="assistant-message-header"
            className="mb-2 flex min-w-0 items-center gap-2 text-[12.5px] leading-5 text-subtle-foreground"
          >
            {/* The model's avatar: the Flint mark on a quiet tile. */}
            <span
              aria-hidden
              className="grid size-[22px] shrink-0 place-items-center rounded-md bg-accent p-[3px] shadow-[inset_0_0_0_0.8px_var(--border)]"
            >
              <FlintMark className="size-full" />
            </span>
            <span className="shrink-0 font-semibold text-foreground">Flint</span>
            {answeredBy && (
              <>
                <span aria-hidden>·</span>
                <span className="min-w-0 truncate" title={answeredBy}>
                  {answeredBy}
                </span>
              </>
            )}
            {!isStreaming && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 tabular-nums">
                  {formatMessageTime(createdAt)}
                </span>
              </>
            )}
          </div>
        )}

        {/* Render message parts */}
        {renderedParts}

        {message.role === 'assistant' && !isStreaming &&
          (webCitations.length > 0 || webReads.length > 0) && (
          <WebSourcesRow citations={webCitations} readUrls={webReads} />
        )}

        {message.role === 'assistant' && !isStreaming && usedSkills.length > 0 && (
          <div
            aria-label={t('common:skillsUsedLabel')}
            className="mt-2 inline-flex h-[22px] max-w-full items-center rounded-md border-[0.8px] border-border bg-card px-2 text-xs font-medium text-secondary-foreground"
          >
            {t('common:skillsUsed', { skills: usedSkills.join(', ') })}
          </div>
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
                <PromptProgress hideIdle={hasPendingToolCall} />
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
                Generation failed
              </div>
              <div className="text-fg-2 break-words">
                {messageError}
              </div>
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
                  <span>Regenerate</span>
                </Button>
              )}
          </div>
        )}

        {/* Message actions for user messages */}
        {message.role === 'user' && !hideActions && (
          <div
            className={cn(
              'mt-1 flex flex-wrap items-center justify-end gap-0.5 text-muted-foreground text-xs',
              REVEAL_ACTIONS
            )}
          >
            <span className="mr-1 text-muted-foreground tabular-nums">
              {formatMessageTime(createdAt)}
            </span>
            {versionNav}
            <span className="inline-flex pointer-coarse:[&_button]:size-11">
              <CopyButton text={getFullTextContent()} />
            </span>

            {onEdit &&
              status !== CHAT_STATUS.STREAMING &&
              status !== CHAT_STATUS.SUBMITTED && (
                <EditMessageDialog
                  message={getFullTextContent()}
                  imageUrls={imageUrls.length > 0 ? imageUrls : undefined}
                  onSave={handleEdit}
                />
              )}

            {onDelete &&
              status !== CHAT_STATUS.STREAMING &&
              status !== CHAT_STATUS.SUBMITTED && (
                <DeleteMessageDialog onDelete={handleDelete} />
              )}
          </div>
        )}

        {/* Message actions for assistant messages (non-tool) */}
        {message.role === 'assistant' && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
              {/* The time is on the header line above. */}
              <div
                className={cn(
                  'flex items-center gap-0.5',
                  // The latest reply keeps its actions in view: retrying or
                  // continuing it is the likely next step.
                  !isLastMessage && REVEAL_ACTIONS,
                  (isStreaming || hideActions) && 'hidden'
                )}
              >
                {versionNav}
                <span className="inline-flex pointer-coarse:[&_button]:size-11">
                  <CopyButton text={getFullTextContent()} />
                </span>

                {onEdit && !isStreaming && (
                  <EditMessageDialog
                    message={getFullTextContent()}
                    onSave={handleEdit}
                  />
                )}

              {onDelete && !isStreaming && (
                <DeleteMessageDialog onDelete={handleDelete} />
              )}

                {selectedModel &&
                  onContinue &&
                  !isStreaming &&
                  isLastMessage &&
                  isStopped && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={ACTION_BUTTON}
                      onClick={handleContinue}
                      title={t('chat:actions.continue')}
                    >
                      <Play className="size-4" />
                    </Button>
                  )}

                {selectedModel && onRegenerate && !isStreaming && isLastMessage && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className={ACTION_BUTTON}
                    onClick={handleRegenerate}
                    title={t('chat:actions.regenerate')}
                  >
                    <RefreshCw className="size-4" />
                  </Button>
                )}
            </div>

            <TokenSpeedIndicator streaming={isStreaming} metadata={metadata} />
          </div>
        )}

        {/* Right-click context menu */}
        <DropdownMenu open={ctxMenuOpen} onOpenChange={setCtxMenuOpen}>
          <DropdownMenuTrigger asChild>
            <span className="sr-only">Message actions</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              onClick={() => navigator.clipboard.writeText(getFullTextContent())}
            >
              <Copy className="mr-2 size-4" />
              {t('chat:actions.copy')}
            </DropdownMenuItem>

            {selectedModel && onRegenerate && !isStreaming && isLastMessage && (
              <DropdownMenuItem onClick={handleRegenerate}>
                <RefreshCw className="mr-2 size-4" />
                {t('chat:actions.regenerate')}
              </DropdownMenuItem>
            )}

            {selectedModel &&
              onContinue &&
              isLastMessage &&
              isStopped &&
              !isStreaming && (
                <DropdownMenuItem onClick={handleContinue}>
                  <Play className="mr-2 size-4" />
                  {t('chat:actions.continue')}
                </DropdownMenuItem>
              )}

            {onDelete && !isStreaming && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={handleDelete}
                >
                  <Trash2 className="mr-2 size-4" />
                  {t('chat:actions.delete')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Image Preview Dialog */}
        {previewImage && (
          <div
            className="fixed inset-0 z-100 bg-background/80 backdrop-blur-md flex items-center justify-center cursor-pointer"
            onClick={() => setPreviewImage(null)}
          >
            <img
              src={previewImage.url}
              alt={previewImage.filename || 'Preview'}
              className="max-h-[90vh] max-w-[90vw] object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
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

    return (
      prevProps.message === nextProps.message &&
      prevProps.isFirstMessage === nextProps.isFirstMessage &&
      prevProps.isLastMessage === nextProps.isLastMessage &&
      prevProps.status === nextProps.status &&
      prevProps.hideActions === nextProps.hideActions &&
      prevProps.keepToolActivity === nextProps.keepToolActivity &&
      prevProps.versionInfo?.index === nextProps.versionInfo?.index &&
      prevProps.versionInfo?.count === nextProps.versionInfo?.count
    )
  }
)

MessageItem.displayName = 'MessageItem'
