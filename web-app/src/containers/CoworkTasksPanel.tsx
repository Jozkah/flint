import { useEffect, useMemo, useState } from 'react'
import {
  Bot,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock,
  Loader2,
  Terminal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { CoworkSidePanel } from '@/containers/CoworkSidePanel'
import { formatCompactDuration } from '@/lib/duration'
import {
  buildTaskList,
  elapsedMs,
  taskTotals,
  type TaskRow,
  type TaskStatus,
} from '@/lib/coworkTasks'
import type { CoworkTurn, SubagentRun } from '@/types/coworkSession'

/** How often running rows re-render so their elapsed time advances. A second
 * is the resolution the duration label shows, so anything finer is wasted
 * work. The interval only runs while something is actually running. */
const TICK_MS = 1000

type Props = {
  /** The run store's live lane for this session. */
  liveSubagents?: SubagentRun[]
  /** Finished subagents committed onto the session. */
  sessionSubagents?: SubagentRun[]
  /** The session transcript, which is where shell commands are recovered from. */
  turns?: CoworkTurn[]
  onClose: () => void
}

/**
 * Everything the current session has running or has run: subagents dispatched
 * by the `task` tool, and shell commands, each with its status, elapsed time,
 * tokens, tool count and — expanded — its own transcript.
 *
 * The rows are derived, not stored: `coworkTasks` reads them off the run store
 * and the committed session, so this panel adds no state of its own beyond
 * which rows are expanded.
 */
export function CoworkTasksPanel({
  liveSubagents,
  sessionSubagents,
  turns,
  onClose,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [showFinished, setShowFinished] = useState(true)

  const rows = useMemo(
    () => buildTaskList({ liveSubagents, sessionSubagents, turns }),
    [liveSubagents, sessionSubagents, turns]
  )
  const totals = useMemo(() => taskTotals(rows), [rows])
  const active = totals.running + totals.queued > 0

  // A running row's elapsed time derives from `Date.now()`, which React has no
  // reason to re-read on its own; tick only while something is running, so an
  // idle panel costs nothing.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [active])

  const live = rows.filter(
    (r) => r.status === 'running' || r.status === 'queued'
  )
  const finished = rows.filter(
    (r) => r.status === 'done' || r.status === 'error'
  )

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <CoworkSidePanel
      title={t('common:tasks.title')}
      summary={
        rows.length > 0 ? (
          <span className="shrink-0 font-mono text-xs tabular-nums text-main-view-fg/60">
            {totals.tokens > 0
              ? t('common:tasks.summary', {
                  count: rows.length,
                  tokens: formatTokens(totals.tokens),
                })
              : t('common:tasks.summaryNoTokens', { count: rows.length })}
          </span>
        ) : null
      }
      onClose={onClose}
    >
      <div className="flex h-full min-h-0 flex-col">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-main-view-fg/50">
            {t('common:tasks.empty')}
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {live.length > 0 && (
              <>
                <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-main-view-fg/40">
                  {t('common:tasks.running', { count: live.length })}
                </p>
                {live.map((row) => (
                  <TaskItem
                    key={row.id}
                    row={row}
                    now={now}
                    expanded={expanded.has(row.id)}
                    onToggle={() => toggle(row.id)}
                  />
                ))}
              </>
            )}

            {finished.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowFinished((v) => !v)}
                  aria-expanded={showFinished}
                  className="flex w-full items-center gap-1 px-3 pb-1 pt-3 text-left"
                >
                  <ChevronDown
                    size={12}
                    className={cn(
                      'shrink-0 text-main-view-fg/40 transition-transform',
                      !showFinished && '-rotate-90'
                    )}
                  />
                  <span className="text-[11px] font-medium uppercase tracking-wider text-main-view-fg/40">
                    {t('common:tasks.finished', { count: finished.length })}
                  </span>
                </button>
                {showFinished &&
                  finished.map((row) => (
                    <TaskItem
                      key={row.id}
                      row={row}
                      now={now}
                      expanded={expanded.has(row.id)}
                      onToggle={() => toggle(row.id)}
                    />
                  ))}
              </>
            )}
          </div>
        )}
      </div>
    </CoworkSidePanel>
  )
}

function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === 'running') {
    return (
      <Loader2
        size={13}
        className="shrink-0 animate-spin text-primary"
        data-testid="task-status-running"
      />
    )
  }
  if (status === 'queued') {
    return (
      <Clock
        size={13}
        className="shrink-0 text-main-view-fg/40"
        data-testid="task-status-queued"
      />
    )
  }
  if (status === 'error') {
    return (
      <CircleAlert
        size={13}
        className="shrink-0 text-destructive"
        data-testid="task-status-error"
      />
    )
  }
  return (
    <CircleCheck
      size={13}
      className="shrink-0 text-main-view-fg/40"
      data-testid="task-status-done"
    />
  )
}

function TaskItem({
  row,
  now,
  expanded,
  onToggle,
}: {
  row: TaskRow
  now: number
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const ms = elapsedMs(row, now)
  const tokens = row.usage?.total_tokens ?? 0

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/50"
      >
        <span className="pt-0.5">
          <StatusIcon status={row.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {row.kind === 'command' ? (
              <Terminal size={12} className="shrink-0 text-main-view-fg/40" />
            ) : (
              <Bot size={12} className="shrink-0 text-main-view-fg/40" />
            )}
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-xs',
                row.kind === 'command' && 'font-mono'
              )}
              title={row.title}
            >
              {row.title}
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-main-view-fg/50">
            {row.status === 'queued' && row.waiting != null && (
              <span>
                {t('common:tasks.queuePosition', { position: row.waiting })}
              </span>
            )}
            {ms != null && (
              <span className="font-mono tabular-nums">
                {formatCompactDuration(Math.round(ms / 1000), t)}
              </span>
            )}
            {tokens > 0 && (
              <span className="font-mono tabular-nums">
                {t('common:tasks.tokens', { tokens: formatTokens(tokens) })}
              </span>
            )}
            {row.toolCount != null && row.toolCount > 0 && (
              <span>
                {t('common:tasks.toolCalls', { count: row.toolCount })}
              </span>
            )}
            {row.jobId && (
              <span className="rounded-sm bg-secondary px-1 font-mono">
                {t('common:tasks.background', { jobId: row.jobId })}
              </span>
            )}
          </span>
        </span>
        <ChevronDown
          size={12}
          className={cn(
            'mt-1 shrink-0 text-main-view-fg/40 transition-transform',
            !expanded && '-rotate-90'
          )}
        />
      </button>

      {expanded && (
        <div className="border-t bg-background px-3 py-2">
          {row.transcript && row.transcript.length > 0 && (
            <ol className="mb-2 space-y-1">
              {row.transcript.map((turn, i) => (
                <li
                  key={`${row.id}-${i}`}
                  className="flex items-baseline gap-2 text-[11px]"
                >
                  <span className="w-14 shrink-0 text-main-view-fg/40">
                    {turn.role === 'tool' ? turn.name : turn.role}
                  </span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate font-mono',
                      turn.isError && 'text-destructive'
                    )}
                  >
                    {turnSummary(turn)}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {row.output ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-[11px]">
              {row.output}
            </pre>
          ) : (
            <p className="text-[11px] text-main-view-fg/40">
              {t('common:tasks.noOutput')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** One transcript line, condensed: what the step was, not its full payload. */
function turnSummary(turn: CoworkTurn): string {
  if (turn.role === 'tool') {
    const args = turn.args
    if (args && typeof args === 'object') {
      const record = args as Record<string, unknown>
      const first = record.command ?? record.path ?? record.pattern
      if (typeof first === 'string') return first
    }
    return turn.result ?? turn.content ?? ''
  }
  return turn.content
}

/** Compact token counts, matching how the transcript header shows them. */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(1)}k`
}
