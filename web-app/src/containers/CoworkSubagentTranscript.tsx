/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowDown, Check, ChevronDown, Copy } from 'lucide-react'
import { TOOL_CARD_CLASS, ToolKindTile, kindOfStep } from '@/components/ToolKindTile'
import { StatStrip, ToolChips } from '@/containers/SubagentStats'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { redactSecrets } from '@/lib/redact'
import { subagentStats, statusLine } from '@/lib/coworkSubagentStats'
import {
  formatStepDuration,
  middleSplit,
  stepDurationMs,
  stepState,
  transcriptItems,
  type StepInfo,
  type StepKind,
} from '@/lib/coworkStepSummary'
import { isFinished, type ActivityTask } from '@/lib/coworkActivity'
import type { CoworkTurn } from '@/types/coworkSession'

/** Characters of one block drawn before "Show more". Keeps a huge tool result
 * from putting megabytes of text in the DOM. */
export const TRANSCRIPT_BLOCK_CHARS = 1500
/** Distance from the bottom (px) within which the view is still "following". */
const FOLLOW_SLACK = 24

/** The one or two arguments that say what a call did, not its whole payload. */
export function keyArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  for (const key of ['path', 'file_path', 'command', 'pattern', 'query', 'url']) {
    const value = record[key]
    if (typeof value === 'string' && value) {
      return value.length > 80 ? `${value.slice(0, 80)}…` : value
    }
  }
  return ''
}

/** A path with its middle cut, never its end: the filename stays readable. */
export function MiddleEllipsis({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const { head, tail } = middleSplit(text)
  return (
    <span
      title={text}
      className={cn('flex min-w-0 items-baseline overflow-hidden font-mono text-[11.5px]', className)}
      data-testid="middle-ellipsis"
    >
      {head ? <span className="min-w-0 truncate">{head}</span> : null}
      <span className="shrink-0 whitespace-nowrap">{tail}</span>
    </span>
  )
}

/** Text bounded to `TRANSCRIPT_BLOCK_CHARS`, with Show more and Copy. */
function Bounded({
  text,
  className,
  testId,
  copy = false,
}: {
  text: string
  className?: string
  testId?: string
  copy?: boolean
}) {
  const { t } = useTranslation()
  const [all, setAll] = useState(false)
  const [copied, setCopied] = useState(false)
  const long = text.length > TRANSCRIPT_BLOCK_CHARS
  const shown = !long || all ? text : text.slice(0, TRANSCRIPT_BLOCK_CHARS)
  const doCopy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => setCopied(false)
    )
  }
  return (
    <div className="relative">
      <pre
        data-testid={testId}
        className={cn(
          'max-h-60 overflow-auto rounded-lg border-[0.8px] border-border bg-muted/50 p-2 pr-8 font-mono text-[11px] leading-[1.55] break-words whitespace-pre-wrap text-foreground [scrollbar-width:thin]',
          className
        )}
      >
        {shown}
      </pre>
      {copy && (
        <button
          type="button"
          onClick={doCopy}
          aria-label={t('common:tasks.copyOutput')}
          className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-hover-btn hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        </button>
      )}
      {long && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="mt-1 text-[11px] text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:underline"
        >
          {all
            ? t('common:tasks.showLess')
            : `${t('common:tasks.showMore')} · ${t('common:tasks.moreChars', {
                count: text.length - TRANSCRIPT_BLOCK_CHARS,
              })}`}
        </button>
      )}
    </div>
  )
}

/** The sentence a step reads as: verb, subject, and where or how much. */
function StepLine({ info }: { info: StepInfo }) {
  const { t } = useTranslation()
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden text-[12px] text-foreground">
      <span className="shrink-0 font-medium text-(--tk)">{t(`common:tasks.step.${info.verb}`)}</span>
      {info.pathLike ? (
        <MiddleEllipsis text={info.subject || '.'} className="flex-1" />
      ) : (
        <span
          title={info.subject}
          className={cn('min-w-0 truncate', info.kind === 'run' && 'font-mono text-[11.5px]')}
        >
          {info.kind === 'search' || info.kind === 'web' ? `“${info.subject}”` : info.subject}
        </span>
      )}
      {info.scope ? (
        <>
          <span className="shrink-0 text-muted-foreground">{t('common:tasks.stepIn')}</span>
          <MiddleEllipsis text={info.scope} className="max-w-[45%]" />
        </>
      ) : null}
      {info.range ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {t('common:tasks.stepLines', { range: info.range })}
        </span>
      ) : null}
    </span>
  )
}

function StepCard({ turn, info }: { turn: CoworkTurn; info: StepInfo }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const state = stepState(turn)
  const ms = stepDurationMs(turn)
  const args = turn.args !== undefined ? redactSecrets(JSON.stringify(turn.args, null, 2)) : ''
  return (
    // The chat's own kind colours: `data-tool-kind` sets --tk (toolKind.css), the
    // tile and the card edge read it (ToolKindTile.tsx), as a chat tool card does.
    <div
      data-testid="transcript-step"
      data-state={state}
      data-tool-kind={kindOfStep(turn.name ?? '', state === 'failed')}
      className={cn(
        TOOL_CARD_CLASS,
        'overflow-hidden rounded-[10px] border-[0.8px] bg-card transition-colors'
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-hover-row focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ToolKindTile name={turn.name ?? ''} running={state === 'active'} />
        <StepLine info={info} />
        {ms !== undefined && state !== 'active' && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {formatStepDuration(ms)}
          </span>
        )}
        <span className="shrink-0" aria-hidden>
          {state === 'active' ? null : state === 'failed' ? (
            <AlertTriangle size={12} className="text-destructive" />
          ) : (
            <Check size={12} className="text-success" />
          )}
        </span>
        <ChevronDown
          size={11}
          aria-hidden
          className={cn('shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')}
        />
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-dashed border-border px-2 pt-1.5 pb-2">
          {args && <Bounded text={args} testId="transcript-tool-args" />}
          {turn.result ? (
            <Bounded
              text={redactSecrets(turn.result)}
              className={cn(state === 'failed' && 'text-destructive')}
              testId="transcript-tool-result"
              copy
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {state === 'active' ? t('common:tasks.noOutput') : t('common:tasks.stepNoResult')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function StepGroup({
  kind,
  steps,
}: {
  kind: StepKind
  steps: { turn: CoworkTurn; info: StepInfo; key: string }[]
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const failed = steps.filter((s) => stepState(s.turn) === 'failed').length
  const active = steps.some((s) => stepState(s.turn) === 'active')
  const label =
    kind === 'read'
      ? t('common:tasks.groupRead', { count: steps.length })
      : kind === 'search'
        ? t('common:tasks.groupSearch', { count: steps.length })
        : t('common:tasks.groupList', { count: steps.length })
  return (
    <div
      data-testid="transcript-group"
      data-tool-kind={kindOfStep(steps[0]?.turn.name ?? '', failed > 0)}
      className={cn(TOOL_CARD_CLASS, 'overflow-hidden rounded-[10px] border-[0.8px] bg-card')}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] outline-none hover:bg-hover-row focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ToolKindTile name={steps[0]?.turn.name ?? ''} running={active} />
        <span className="flex-1 font-medium text-(--tk)">{label}</span>
        {failed > 0 && (
          <span className="shrink-0 text-[11px] text-destructive">
            {t('common:tasks.toolCallsFailed', { count: failed })}
          </span>
        )}
        {active ? null : (
          <Check size={12} aria-hidden className="shrink-0 text-success" />
        )}
        <ChevronDown
          size={11}
          aria-hidden
          className={cn('shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')}
        />
      </button>
      {open && (
        <div className="space-y-1 border-t border-dashed border-border p-1.5">
          {steps.map((s) => (
            <StepCard key={s.key} turn={s.turn} info={s.info} />
          ))}
        </div>
      )}
    </div>
  )
}

const STATUS_TEXT: Record<string, string> = {
  queued: 'text-amber-600 dark:text-amber-400',
  thinking: 'text-acc-text',
  command: 'text-acc-text',
  reading: 'text-acc-text',
  searching: 'text-acc-text',
  editing: 'text-acc-text',
  web: 'text-acc-text',
  tool: 'text-acc-text',
  finished: 'text-success',
  failed: 'text-destructive',
  cancelled: 'text-orange-600 dark:text-orange-400',
}

/**
 * One subagent's conversation, read like a chat.
 *
 * A compact header (role, model, state, tokens, turns, tool calls, elapsed), the
 * brief as a collapsed first message, the child's prose through the same
 * markdown renderer chat uses, its tool calls as one-line steps (grouped when
 * they repeat, each with status and duration, expandable to arguments and a
 * bounded, copyable result), and the final answer as a card of its own.
 * Reads only what the Tasks record holds, so it updates as that does; follows
 * the bottom while the child runs, and offers "Jump to latest" once you scroll
 * up. Everything drawn passes through `redactSecrets`; the system prompt is
 * not part of the record, so it cannot be shown.
 */
export function CoworkSubagentTranscript({
  task,
  onClose,
  showFinal = true,
}: {
  task: ActivityTask
  onClose?: () => void
  /** Draw the final result here. The Tasks panel draws it itself, with its
   * copy control, and turns this off. */
  showFinal?: boolean
}) {
  const { t } = useTranslation()
  const turns = task.transcript ?? []
  const items = transcriptItems(turns)
  const finished = isFinished(task.status)
  const running = task.status === 'running'
  const queued = task.status === 'queued'
  const scroller = useRef<HTMLDivElement | null>(null)
  const [following, setFollowing] = useState(true)
  const [briefOpen, setBriefOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])

  const stats = subagentStats(task, now)
  const line = statusLine(task)

  useEffect(() => {
    const el = scroller.current
    if (el && following && running) el.scrollTop = el.scrollHeight
  }, [items.length, turns.length, task.output, following, running])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK)
  }
  const jump = () => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
    setFollowing(true)
  }

  const nothingYet = items.length === 0 && !task.output
  const failedTask = task.status === 'error'

  return (
    <div
      data-testid="subagent-transcript"
      className="relative"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && onClose) {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div
        ref={scroller}
        onScroll={onScroll}
        tabIndex={0}
        aria-label={t('common:tasks.transcript')}
        className="max-h-[26rem] overflow-auto rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring [scrollbar-width:thin]"
      >
        {/* Sticky: what this is and how it is going stays in view while the
            conversation scrolls under it. */}
        <div
          data-testid="transcript-header"
          className="sticky top-0 z-10 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-card/95 px-2.5 py-1.5 text-[11.5px] backdrop-blur"
        >
          {task.agentName && (
            <span className="rounded-md border-[0.8px] border-border px-1.5 py-0.5 font-medium text-foreground">
              {task.agentName}
            </span>
          )}
          {task.model && (
            <span className="rounded-md border-[0.8px] border-border px-1.5 py-0.5 text-muted-foreground">
              {task.model}
            </span>
          )}
          {task.assistant && (
            <span className="rounded-md border-[0.8px] border-border px-1.5 py-0.5 text-muted-foreground" data-testid="task-assistant-chip">
              {task.assistant}
            </span>
          )}
          {task.profile && (
            <span className="rounded-md border-[0.8px] border-border px-1.5 py-0.5 text-muted-foreground" data-testid="task-profile-chip">
              {task.profile}
            </span>
          )}
          <span
            data-testid="transcript-status"
            className={cn('font-medium', STATUS_TEXT[line])}
          >
            {t(`common:tasks.line.${line}`)}
          </span>
        </div>

        {((!queued && showFinal) || stats.tools.total > 0) && (
          <div className="space-y-2 border-b border-border px-2.5 py-2" data-testid="transcript-stats">
            {!queued && showFinal && <StatStrip stats={stats} testId="transcript-stat-strip" />}
            <ToolChips stats={stats} />
          </div>
        )}

        <div className="space-y-2 p-2.5">
          {task.description && (
            <div className="rounded-lg border-[0.8px] border-border bg-muted/40 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium tracking-[0.02em] text-muted-foreground uppercase">
                  {t('common:tasks.taskLabel')}
                </span>
                <button
                  type="button"
                  aria-expanded={briefOpen}
                  onClick={() => setBriefOpen((v) => !v)}
                  className="text-[11px] text-primary underline-offset-2 outline-none hover:underline focus-visible:underline"
                >
                  {briefOpen ? t('common:tasks.hideBrief') : t('common:tasks.showBrief')}
                </button>
              </div>
              <p
                data-testid="transcript-brief"
                className={cn(
                  'mt-1 text-[12.5px] leading-[1.5] break-words whitespace-pre-wrap text-foreground',
                  !briefOpen && 'line-clamp-2'
                )}
              >
                {redactSecrets(task.description)}
              </p>
            </div>
          )}

          {nothingYet && (
            <p className="px-0.5 text-[12px] text-muted-foreground" data-testid="transcript-empty">
              {queued
                ? task.waiting != null
                  ? t('common:tasks.waitingPosition', { position: task.waiting })
                  : t('common:tasks.waitingToStart')
                : running
                  ? t('common:tasks.starting')
                  : t('common:tasks.transcriptEmpty')}
            </p>
          )}

          {items.map((item, i) => {
            if (item.type === 'text') {
              return (
                <div key={item.key} data-testid="transcript-assistant" className="px-0.5 text-[13px]">
                  <RenderMarkdown
                    content={redactSecrets(item.text)}
                    isStreaming={running && i === items.length - 1}
                  />
                </div>
              )
            }
            if (item.type === 'group') {
              return <StepGroup key={item.key} kind={item.kind} steps={item.steps} />
            }
            return <StepCard key={item.key} turn={item.turn} info={item.info} />
          })}

          {showFinal && task.output && finished && (
            <div
              data-testid="transcript-final"
              className={cn(
                'rounded-lg border-[0.8px] p-2.5 shadow-lift',
                failedTask ? 'border-destructive/40 bg-destructive-tint' : 'border-border bg-card'
              )}
            >
              <p
                className={cn(
                  'mb-1.5 text-[11px] font-medium tracking-[0.02em] uppercase',
                  failedTask ? 'text-destructive' : 'text-muted-foreground'
                )}
              >
                {failedTask
                  ? t('common:tasks.transcriptFailed', { error: redactSecrets(task.output).slice(0, 160) })
                  : t('common:tasks.transcriptFinal')}
              </p>
              <Bounded text={redactSecrets(task.output)} copy className="bg-transparent" />
              {task.resultCapped && (
                <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid="transcript-capped">
                  {t('common:tasks.resultCapped')}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      {running && !following && (
        <button
          type="button"
          onClick={jump}
          data-testid="transcript-jump"
          className="absolute right-3 bottom-3 inline-flex items-center gap-1 rounded-full border-[0.8px] border-border bg-card px-2.5 py-1 text-[11.5px] text-foreground shadow-lift outline-none hover:bg-hover-btn focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowDown size={12} aria-hidden />
          {t('common:tasks.jumpToLatest')}
        </button>
      )}
      {running && !following && (
        <p className="sr-only" role="status">
          {t('common:tasks.followPaused')}
        </p>
      )}
    </div>
  )
}
