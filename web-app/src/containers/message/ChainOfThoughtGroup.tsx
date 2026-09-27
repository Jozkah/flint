import { memo, useId, useState } from 'react'
import { twMerge } from 'tailwind-merge'
import { ArrowDown, Check, ChevronRight } from 'lucide-react'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from '@/components/ai-elements/chain-of-thought'
import {
  ReasoningActiveStep,
  StepRow,
  TIMELINE_RAIL,
} from '@/components/ai-elements/reasoning-timeline'
import { Button } from '@/components/ui/button'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import {
  findRunningToolCallId,
  useToolCallRuntime,
} from '@/hooks/useToolCallRuntime'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { partitionTrace, type TranscriptView } from '@/lib/transcriptView'
import { cn } from '@/lib/utils'
import { segmentReasoningSteps } from '@/lib/reasoning'
import { ToolCallCard } from './ToolCallCard'
import { CONTENT_TYPE, isToolPart, type PartEntry } from './types'

// Turn a tool identifier (e.g. "web_search", "exa_search") into a readable
// label for the streaming step header (e.g. "Web search").
function humanizeToolName(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').trim()
  if (!spaced) return 'tool'
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export type ChainOfThoughtGroupProps = {
  /** Reasoning and tool parts belonging to this trace, in message order. */
  entries: PartEntry[]
  messageId: string
  /** Total parts on the message, used to detect the currently streaming part. */
  totalParts: number
  isStreaming: boolean
  /** An answer follows this trace, so it should auto-collapse. */
  hasFollowingContent: boolean
  /** Any tool on the message awaits approval; pins the trace open. */
  awaitingApproval: boolean
  /**
   * Keep tool activity on screen once the answer arrives. AH-172.
   *
   * In a chat thread a finished trace folds into "Worked for 8s", because the
   * reasoning is scaffolding and the answer is the point. In Cowork the tool
   * calls *are* the work -- what was read, what was changed, what was refused
   * -- and folding them away leaves the user with the model's word for it.
   */
  keepToolActivity?: boolean
  citationOffsets: Map<number, number>
  reasoningContainerRef?: React.RefObject<HTMLDivElement | null>
  isReasoningAtBottom?: boolean
  onReasoningScroll?: () => void
  onReasoningScrollToBottom?: () => void
  /**
   * Overrides the Transcript view setting. `trace` renders the trace as it
   * always has; the compact modes use it for the reasoning they keep.
   */
  transcriptView?: TranscriptView | 'trace'
}

/**
 * Normal and Thinking views: reasoning only in Thinking, calls awaiting
 * approval (and in Thinking failed calls, closed) in place, every other call behind one "N steps"
 * disclosure.
 */
const CompactTrace = ({
  mode,
  groupIsStreaming,
  props,
}: {
  mode: 'normal' | 'thinking'
  groupIsStreaming: boolean
  props: ChainOfThoughtGroupProps
}) => {
  const { t } = useTranslation()
  const pending = useToolApprovalRequests((s) => s.pending)
  const [open, setOpen] = useState(false)
  const listId = useId()
  const { entries, messageId, citationOffsets } = props
  const { reasoning, pinned, steps } = partitionTrace(mode, entries, (id) =>
    Boolean(pending[id])
  )
  const card = ({ part, index }: PartEntry, expanded?: boolean) => (
    <ToolCallCard
      key={`${messageId}-t-${index}`}
      part={part}
      messageId={messageId}
      citationOffset={citationOffsets.get(index) ?? 0}
      expanded={expanded}
      className="mb-1"
    />
  )
  const working = groupIsStreaming && pinned.length === 0
  return (
    <div data-transcript-view={mode} className="mb-2.5 w-full text-muted-foreground">
      {reasoning.length > 0 && (
        <ChainOfThoughtGroup
          {...props}
          entries={reasoning}
          awaitingApproval={false}
          transcriptView="trace"
        />
      )}
      {pinned.map((e) =>
        card(e, e.part.state === 'output-error' ? false : undefined)
      )}
      {steps.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            onClick={() => setOpen((v) => !v)}
            data-testid="transcript-steps-toggle"
            className="inline-flex min-h-6 cursor-pointer items-center gap-1 rounded-md text-xs transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:min-h-11"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                'size-3 shrink-0 transition-transform duration-200',
                open && 'rotate-90'
              )}
            />
            {t('chat:transcriptView.steps', { count: steps.length })}
            {working && (
              <span className="motion-safe:animate-pulse">
                {' · '}
                {t('chat:transcriptView.working')}
              </span>
            )}
          </button>
          {open && (
            <ol id={listId} className={cn(TIMELINE_RAIL, 'mt-1')}>
              {steps.map((e, i) => (
                <StepRow key={`${messageId}-s-${e.index}`} index={i}>
                  {card(e, true)}
                </StepRow>
              ))}
            </ol>
          )}
        </>
      ) : (
        working &&
        mode === 'normal' &&
        reasoning.length === 0 && (
          <span className="text-xs motion-safe:animate-pulse">
            {t('chat:reasoning.thinking')}
          </span>
        )
      )}
    </div>
  )
}

export const ChainOfThoughtGroup = memo(
  (props: ChainOfThoughtGroupProps) => {
    const {
    entries,
    messageId,
    totalParts,
    isStreaming,
    hasFollowingContent,
    awaitingApproval,
    keepToolActivity,
    citationOffsets,
    reasoningContainerRef,
    isReasoningAtBottom,
    onReasoningScroll,
    onReasoningScrollToBottom,
    transcriptView,
  } = props
    const { t } = useTranslation()
    const storedView = useInterfaceSettings((s) => s.transcriptView)
    const mode = transcriptView ?? storedView
    const verbose = mode === 'verbose'
    const pendingApprovals = useToolApprovalRequests((s) => s.pending)
    const runningToolCallId = useToolCallRuntime((s) => findRunningToolCallId(s.timings))
    // How long the trace's tools took end to end, from their recorded timings:
    // a trace loaded from history was never timed live, and this is the one
    // measure of it that is real rather than "a few seconds".
    const toolSpanSeconds = useToolCallRuntime((s) => {
      let first = Infinity
      let last = -Infinity
      for (const { part } of entries) {
        const timing = part.toolCallId ? s.timings[part.toolCallId] : undefined
        if (timing?.startedAt === undefined || timing.endedAt === undefined) continue
        first = Math.min(first, timing.startedAt)
        last = Math.max(last, timing.endedAt)
      }
      return last > first ? Math.max(1, Math.round((last - first) / 1000)) : undefined
    })
    const [view, setView] = useState<'condensed' | 'extended'>(
      verbose ? 'extended' : 'condensed'
    )

    if (entries.length === 0) return null

    const hasTools = entries.some((e) => isToolPart(e.part))

    const lastEntryIndex = entries[entries.length - 1].index
    const groupIsStreaming = isStreaming && lastEntryIndex === totalParts - 1

    if (mode === 'normal' || mode === 'thinking') {
      return (
        <CompactTrace mode={mode} groupIsStreaming={groupIsStreaming} props={props} />
      )
    }
    // The extended timeline only exists while streaming; once the turn ends the
    // full rail is what renders anyway.
    const isExtended = groupIsStreaming && view === 'extended'

    // While streaming, surface only the latest step (current reasoning
    // paragraph or tool call) so each step replaces the previous one rather
    // than the whole trace scrolling by. The full trace renders once done.
    const isMeaningfulEntry = ({ part }: PartEntry) => {
      if (part.type === CONTENT_TYPE.REASONING) {
        return Boolean(part.text && part.text.trim())
      }
      return isToolPart(part)
    }
    const meaningful = entries.filter(isMeaningfulEntry)
    // Tools execute one at a time, so with several calls in a turn the last
    // part is the one at the back of the queue. Follow the call actually doing
    // the work; before execution starts nothing is running and the newest part
    // is still the right thing to show as it streams in.
    const running = runningToolCallId
      ? meaningful.find((e) => e.part.toolCallId === runningToolCallId)
      : undefined
    const lastMeaningful = running ?? meaningful[meaningful.length - 1]
    // While streaming, show only the current step — but never truncate away a
    // tool part that is awaiting the user's approval, or its approve/deny
    // controls would never mount and the run would hang (multi-tool turns).
    const visibleEntries =
      groupIsStreaming && meaningful.length > 0
        ? meaningful.filter((e) => {
            if (e === lastMeaningful) return true
            const toolCallId = e.part.toolCallId
            return Boolean(toolCallId && pendingApprovals[toolCallId])
          })
        : entries

    // Streaming label reflects the current step, not whether the whole trace
    // ever used a tool — otherwise it sticks on "Using tools…" once the model
    // resumes reasoning after a tool call.
    const currentStepIsTool = Boolean(
      lastMeaningful && isToolPart(lastMeaningful.part)
    )

    const currentToolLabel = currentStepIsTool
      ? humanizeToolName(lastMeaningful.part.type.split('-').slice(1).join('-'))
      : ''

    // While streaming, expand for a tool call -- its card carries the live
    // search/address bar and the result, all of which sit inside this
    // collapsible -- or for reasoning that has a settled step to show, i.e. the
    // trace has advanced past its first step. Once done, any reasoning text
    // qualifies. An answer following the trace still collapses it, so the card
    // does not linger once the model moves on.
    const hasDisplayableContent = groupIsStreaming
      ? currentStepIsTool ||
        (lastMeaningful?.part.type === CONTENT_TYPE.REASONING &&
          segmentReasoningSteps(lastMeaningful.part.text ?? '').length >= 2)
      : entries.some(
          (e) =>
            e.part.type === CONTENT_TYPE.REASONING &&
            Boolean(e.part.text && e.part.text.trim())
        )

    // Pinned open while a tool awaits approval — its approve/deny controls live
    // inside the collapsible and must stay mounted even if an answer has
    // started. The extended view always has the live step to show, so it must
    // not be collapsed out from under the reader who just opened it.
    const carriesTools = entries.some((e) => isToolPart(e.part))
    const shouldCollapse = verbose
      ? false
      : keepToolActivity && carriesTools
        ? false
        : hasFollowingContent || !(hasDisplayableContent || isExtended)

    // Done/historical: flatten every entry (reasoning paragraphs, tool calls)
    // into steps on a single continuous solid rail, so a tool call between two
    // reasoning paragraphs stays threaded instead of restarting the rail.
    // `live` keeps the in-progress step as the trailing row and drops the Done
    // marker, so the same rail serves the extended streaming view.
    const renderTimeline = (rows: PartEntry[], live: boolean) => {
      const steps: React.ReactNode[] = []
      for (const { part, index: partIndex } of rows) {
        if (part.type === CONTENT_TYPE.REASONING) {
          const text = part.text ?? ''
          const segments = segmentReasoningSteps(text)
          const isLivePart = live && partIndex === totalParts - 1
          const settled = isLivePart ? segments.slice(0, -1) : segments
          for (const [pi, para] of settled.entries()) {
            steps.push(
              <StepRow
                key={`${messageId}-r-${partIndex}-${pi}`}
                index={steps.length}
                text={para}
              />
            )
          }
          if (isLivePart && segments.length > 0) {
            steps.push(
              <StepRow key={`${messageId}-rl-${partIndex}`} index={steps.length}>
                <ReasoningActiveStep text={text} mode="live" />
              </StepRow>
            )
          }
          continue
        }
        if (isToolPart(part)) {
          steps.push(
            <StepRow key={`${messageId}-t-${partIndex}`} index={steps.length}>
              <ToolCallCard
                part={part}
                messageId={messageId}
                citationOffset={citationOffsets.get(partIndex) ?? 0}
                expanded={verbose || undefined}
              />
            </StepRow>
          )
        }
      }
      if (steps.length === 0) return null
      if (!live) {
        steps.push(
          <StepRow
            key={`${messageId}-done`}
            marker={<Check aria-hidden />}
            text={t('chat:done')}
          />
        )
      }
      return <ol className={TIMELINE_RAIL}>{steps}</ol>
    }

    // Auto-followed viewport: the parent's scroll hook keeps it pinned to the
    // newest content until the reader scrolls up.
    const autoFollowBox = (content: React.ReactNode, maxHeight: string) => (
      <div className="relative">
        <div
          ref={reasoningContainerRef}
          onScroll={onReasoningScroll}
          className={twMerge(
            'w-full overflow-auto relative',
            maxHeight,
            '[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden'
          )}
        >
          {content}
        </div>
        {!isReasoningAtBottom && (
          <Button
            className="absolute bottom-2 left-[50%] translate-x-[-50%] rounded-full size-7 z-10 pointer-coarse:size-11"
            onClick={onReasoningScrollToBottom}
            size="icon"
            type="button"
            variant="outline"
          >
            <ArrowDown className="size-3" />
          </Button>
        )}
      </div>
    )

    // Condensed: the settled step only, so the text does not shift mid-read.
    // 5 lines of text-sm (1.25rem line-height).
    const renderCondensed = () =>
      visibleEntries.map(({ part, index: partIndex }) => {
        if (part.type === CONTENT_TYPE.REASONING) {
          if (partIndex !== totalParts - 1) return null
          return (
            <div key={`${messageId}-r-${partIndex}`}>
              {autoFollowBox(
                <ReasoningActiveStep text={part.text ?? ''} />,
                'max-h-[6.25rem]'
              )}
            </div>
          )
        }

        return (
          <ToolCallCard
            key={`${messageId}-t-${partIndex}`}
            part={part}
            messageId={messageId}
            citationOffset={citationOffsets.get(partIndex) ?? 0}
            className="mb-1"
          />
        )
      })

    return (
      <ChainOfThought
        className="mb-2.5 w-full text-muted-foreground"
        isStreaming={groupIsStreaming}
        shouldCollapse={shouldCollapse}
        forceOpen={awaitingApproval}
        defaultOpen={verbose || (hasDisplayableContent && !hasFollowingContent)}
        fallbackDuration={toolSpanSeconds}
      >
        <ChainOfThoughtHeader
          streamingLabel={
            currentStepIsTool
              ? t('chat:reasoning.usingTool', { tool: currentToolLabel })
              : t('chat:reasoning.thinking')
          }
          completedVariant={hasTools ? 'worked' : 'thought'}
          navDirection={
            groupIsStreaming ? (isExtended ? 'left' : 'right') : undefined
          }
          onNavigate={() => setView(isExtended ? 'condensed' : 'extended')}
        />
        <ChainOfThoughtContent>
          {!groupIsStreaming
            ? renderTimeline(entries, false)
            : isExtended
              ? // The live timeline flows at full size along the chat, as it
                // does once the turn ends; no capped inner scroll box.
                renderTimeline(entries, true)
              : renderCondensed()}
        </ChainOfThoughtContent>
      </ChainOfThought>
    )
  }
)

ChainOfThoughtGroup.displayName = 'ChainOfThoughtGroup'
