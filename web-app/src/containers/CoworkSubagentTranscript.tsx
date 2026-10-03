/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { redactSecrets } from '@/lib/redact'
import { subagentStats } from '@/lib/coworkSubagentStats'
import type { ActivityTask } from '@/lib/coworkActivity'
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

/** Text bounded to `TRANSCRIPT_BLOCK_CHARS` with an inline "Show more". */
function Bounded({
  text,
  className,
  testId,
}: {
  text: string
  className?: string
  testId?: string
}) {
  const { t } = useTranslation()
  const [all, setAll] = useState(false)
  const long = text.length > TRANSCRIPT_BLOCK_CHARS
  const shown = !long || all ? text : text.slice(0, TRANSCRIPT_BLOCK_CHARS)
  return (
    <>
      <pre
        data-testid={testId}
        className={cn(
          'max-h-64 overflow-auto rounded-lg border-[0.8px] border-term-border bg-term-bg p-2 font-mono text-[11px] leading-[1.55] break-words whitespace-pre-wrap text-term-fg [scrollbar-width:thin]',
          className
        )}
      >
        {shown}
      </pre>
      {long && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="mt-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        >
          {all
            ? t('common:tasks.showLess')
            : `${t('common:tasks.showMore')} · ${t('common:tasks.moreChars', {
                count: text.length - TRANSCRIPT_BLOCK_CHARS,
              })}`}
        </button>
      )}
    </>
  )
}

function ToolTurn({ turn }: { turn: CoworkTurn }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const failed = turn.isError || turn.toolState === 'failed'
  const summary = keyArgs(turn.args)
  const args =
    turn.args !== undefined ? redactSecrets(JSON.stringify(turn.args, null, 2)) : ''
  return (
    <li className="text-[11px]" data-testid="transcript-tool">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-baseline gap-2 text-left outline-none hover:bg-hover-row focus-visible:bg-hover-row"
      >
        <ChevronDown
          size={10}
          className={cn('shrink-0 self-center text-muted-foreground', !open && '-rotate-90')}
        />
        <span className="w-14 shrink-0 text-muted-foreground">{turn.name}</span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-mono',
            failed && 'text-destructive'
          )}
        >
          {summary ? redactSecrets(summary) : ''}
          {turn.status === 'running' && !turn.result ? ' …' : ''}
        </span>
      </button>
      {open && (
        <div className="mt-1 mb-2 pl-5">
          {args && <Bounded text={args} testId="transcript-tool-args" />}
          {turn.result ? (
            <div className="mt-1">
              <Bounded
                text={redactSecrets(turn.result)}
                className={cn(failed && 'text-destructive')}
                testId="transcript-tool-result"
              />
            </div>
          ) : (
            <p className="mt-1 text-muted-foreground">
              {t('common:tasks.noOutput')}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * One subagent's own conversation: the brief it was given, what it said, each
 * tool call (collapsed until opened) and its final result.
 *
 * Reads only what the Tasks record already holds, so it updates as the record
 * does. Follows the bottom while the child runs and stops following the moment
 * the reader scrolls up, so reading is never fought. Everything drawn passes
 * through `redactSecrets`, and the child's system prompt is never part of the
 * record, so it cannot be shown.
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
  const running = task.status === 'running' || task.status === 'queued'
  const scroller = useRef<HTMLDivElement | null>(null)
  const [following, setFollowing] = useState(true)
  const stats = subagentStats(task, 0)
  const failedTask = task.status === 'error'

  useEffect(() => {
    const el = scroller.current
    if (el && following && running) el.scrollTop = el.scrollHeight
  }, [turns.length, task.output, following, running])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK)
  }

  const empty = turns.length === 0 && !task.output && !task.description

  return (
    <div
      data-testid="subagent-transcript"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && onClose) {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      {stats.tools.total > 0 && (
        <p className="mb-1 text-[11px] text-muted-foreground" data-testid="transcript-tool-breakdown">
          {t('common:tasks.toolBreakdown', {
            list: Object.entries(stats.tools.byTool)
              .map(([name, n]) => `${name} ×${n}`)
              .join(', '),
          })}
          {stats.tools.active > 0 &&
            ` · ${t('common:tasks.toolCallsRunning', { count: stats.tools.active })}`}
          {stats.tools.failed > 0 &&
            ` · ${t('common:tasks.toolCallsFailed', { count: stats.tools.failed })}`}
        </p>
      )}
      <div
        ref={scroller}
        onScroll={onScroll}
        tabIndex={0}
        aria-label={t('common:tasks.transcript')}
        className="max-h-80 space-y-2 overflow-auto pr-1 outline-none [scrollbar-width:thin]"
      >
        {empty && (
          <p className="text-[11px] text-muted-foreground">
            {t('common:tasks.transcriptEmpty')}
          </p>
        )}
        {task.description && (
          <div>
            <p className="text-[11px] font-medium text-muted-foreground">
              {t('common:tasks.briefHeading')}
            </p>
            <Bounded text={redactSecrets(task.description)} testId="transcript-brief" />
          </div>
        )}
        {turns.length > 0 && (
          <ol className="space-y-1">
            {turns.map((turn, i) =>
              turn.role === 'tool' ? (
                <ToolTurn key={`${task.id}-${i}`} turn={turn} />
              ) : turn.role === 'assistant' && turn.content.trim() ? (
                <li key={`${task.id}-${i}`} className="text-[11px]" data-testid="transcript-assistant">
                  <span className="text-muted-foreground">
                    {t('common:tasks.transcriptAssistant')}
                  </span>
                  <Bounded text={redactSecrets(turn.content)} className="font-sans" />
                </li>
              ) : null
            )}
          </ol>
        )}
        {showFinal && task.output && !running && (
          <div data-testid="transcript-final">
            <p
              className={cn(
                'text-[11px] font-medium',
                failedTask ? 'text-destructive' : 'text-muted-foreground'
              )}
            >
              {failedTask
                ? t('common:tasks.transcriptFailed', {
                    error: redactSecrets(task.output).slice(0, 160),
                  })
                : t('common:tasks.transcriptFinal')}
            </p>
            <Bounded text={redactSecrets(task.output)} />
            {task.resultCapped && (
              <p className="mt-1 text-[11px] text-muted-foreground" data-testid="transcript-capped">
                {t('common:tasks.resultCapped')}
              </p>
            )}
          </div>
        )}
      </div>
      {running && !following && (
        <p className="mt-1 text-[11px] text-muted-foreground" role="status">
          {t('common:tasks.followPaused')}
        </p>
      )}
    </div>
  )
}
