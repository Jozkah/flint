import { useCallback, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Copy,
  ExternalLink,
  FilePen,
  FilePlus,
  FileSearch,
  FileX,
  GitBranch,
  Loader2,
  ShieldQuestion,
  Terminal,
  TriangleAlert,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  accessibleLabel,
  activityCounts,
  copyTextFor,
  filterActivity,
  hasExpandableDetail,
  navigationTarget,
  type ActivityEvent,
  type ActivityLog,
} from '@/lib/activityEvents'

/**
 * The run's activity, inline in the conversation (AH-201).
 *
 * A projection of `useActivityTimeline`, which is the only store it reads: the
 * rail, the Background Tasks panel and the audit export project the same log, so
 * a reader who checks two of them sees one answer.
 *
 * What it shows is observable execution: what was read, what changed and by how
 * many lines, what ran and how it exited, what was asked of the user and what
 * they answered, what git did, what was retried or cancelled. What it never shows
 * is the model's reasoning -- see the note in `activityEvents.ts` for why that
 * line is drawn at the model and not at the renderer.
 *
 * Long lists are virtualized, because a run of a few hundred tool calls is
 * ordinary and a few thousand rows of DOM is not.
 */

/** Rows past which the list is virtualized rather than rendered whole. */
const VIRTUALIZE_ABOVE = 40

/** Estimated row height, for the virtualizer's initial guess. */
const ROW_HEIGHT = 34

/** Output lines kept in an expanded row. The tail is the part that says why. */
const MAX_EXPANDED_LINES = 200

/**
 * A duration for the metadata chip.
 *
 * Not `formatCompactDuration`: that one speaks in whole seconds through the
 * translation layer, and a tool call is usually faster than a second -- rounding
 * every read to "0s" would tell the reader nothing. Milliseconds below a second,
 * one decimal below a minute, then minutes and seconds. Unit-free enough not to
 * need a translation key, which is also why it does not take `t`.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

/** The filters offered, in the order they are shown. */
const FILTERS = [
  { id: 'all', kinds: undefined },
  { id: 'files', kinds: ['file.'] },
  { id: 'commands', kinds: ['command', 'verification'] },
  { id: 'permissions', kinds: ['permission.'] },
  { id: 'git', kinds: ['git'] },
] as const

type FilterId = (typeof FILTERS)[number]['id'] | 'problems'

type Props = {
  /** The session's log. Passed in rather than selected here so the component
   *  stays a pure projection and can be tested without the store. */
  log: ActivityLog
  /** Show only the events of one tool call, for a row expanded in a message. */
  callId?: string
  /** Open a file the timeline points at. Absent disables the affordance
   *  entirely rather than rendering a button that does nothing. */
  onOpenFile?: (path: string, line?: number) => void
  /** Copy handler, so the surrounding surface owns clipboard access and its
   *  permission prompts. Absent hides the copy affordance. */
  onCopy?: (text: string) => void
  className?: string
}

export function ActivityTimeline({
  log,
  callId,
  onOpenFile,
  onCopy,
  className,
}: Props) {
  const [filter, setFilter] = useState<FilterId>('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)

  const events = useMemo(() => {
    const chosen = FILTERS.find((one) => one.id === filter)
    return filterActivity(log, {
      kinds: chosen?.kinds ? [...chosen.kinds] : undefined,
      statuses: filter === 'problems' ? ['error', 'cancelled'] : undefined,
      query: query.trim() || undefined,
      callId,
    })
  }, [log, filter, query, callId])

  const counts = useMemo(() => activityCounts(log), [log])

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    initialRect: { width: 640, height: 400 },
  })

  const virtualized = events.length > VIRTUALIZE_ABOVE
  // A virtualizer needs a measured scroll container. Where there is none -- a
  // collapsed panel, a hidden tab, a test environment with no layout -- it
  // reports an empty window, and rendering that faithfully means rendering a
  // list with nothing in it. Falling back to the first page keeps the timeline
  // readable and keeps it announced with its true length.
  const window = virtualizer.getVirtualItems()
  const fallback =
    window.length === 0 && events.length > 0
      ? events.slice(0, VIRTUALIZE_ABOVE)
      : []

  return (
    <section
      className={cn('flex flex-col gap-2 text-xs', className)}
      aria-label="Run activity"
    >
      <header className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter activity" className="flex gap-1">
          {[...FILTERS, { id: 'problems' as const, kinds: undefined }].map((one) => (
            <button
              key={one.id}
              type="button"
              onClick={() => setFilter(one.id as FilterId)}
              aria-pressed={filter === one.id}
              className={cn(
                'rounded px-2 py-0.5 capitalize',
                filter === one.id
                  ? 'bg-main-view-fg/10 text-main-view-fg'
                  : 'text-main-view-fg/60 hover:text-main-view-fg'
              )}
            >
              {one.id}
              {one.id === 'problems' && counts.error > 0 ? ` (${counts.error})` : ''}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-1">
          <span className="sr-only">Search activity</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-40 rounded border border-main-view-fg/10 bg-transparent px-2 py-0.5"
          />
        </label>
      </header>

      {log.dropped > 0 && (
        <p className="text-main-view-fg/50">
          {log.dropped} earlier {log.dropped === 1 ? 'event' : 'events'} are no longer
          kept.
        </p>
      )}

      {events.length === 0 ? (
        <p className="py-2 text-main-view-fg/50">
          {counts.total === 0
            ? 'Nothing has run yet.'
            : 'No activity matches this filter.'}
        </p>
      ) : (
        <div
          ref={scrollRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={`${events.length} activity events`}
          className="max-h-80 overflow-y-auto"
        >
          {virtualized ? (
            <ul
              className="relative w-full list-none"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {window.map((item) => (
                <li
                  key={events[item.index].id}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <Row
                    event={events[item.index]}
                    expanded={expanded.has(events[item.index].id)}
                    onToggle={toggle}
                    onOpenFile={onOpenFile}
                    onCopy={onCopy}
                  />
                </li>
              ))}
              {fallback.map((event) => (
                <li key={event.id} className="relative w-full">
                  <Row
                    event={event}
                    expanded={expanded.has(event.id)}
                    onToggle={toggle}
                    onOpenFile={onOpenFile}
                    onCopy={onCopy}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <ul className="list-none">
              {events.map((event) => (
                <li key={event.id}>
                  <Row
                    event={event}
                    expanded={expanded.has(event.id)}
                    onToggle={toggle}
                    onOpenFile={onOpenFile}
                    onCopy={onCopy}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

type RowProps = {
  event: ActivityEvent
  expanded: boolean
  onToggle: (id: string) => void
  onOpenFile?: (path: string, line?: number) => void
  onCopy?: (text: string) => void
}

function Row({ event, expanded, onToggle, onOpenFile, onCopy }: RowProps) {
  const canExpand = hasExpandableDetail(event)
  const target = navigationTarget(event)
  const label = accessibleLabel(event)

  return (
    <div className="group">
      <div className="flex items-center gap-2 py-1">
        {canExpand ? (
          <button
            type="button"
            onClick={() => onToggle(event.id)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${event.title}`}
            className="text-main-view-fg/50 hover:text-main-view-fg"
          >
            {expanded ? (
              <ChevronDown className="size-3" aria-hidden />
            ) : (
              <ChevronRight className="size-3" aria-hidden />
            )}
          </button>
        ) : (
          // A fixed-width spacer, so rows without a chevron still line up and no
          // affordance is rendered that does nothing.
          <span className="inline-block size-3" aria-hidden />
        )}

        <StatusIcon event={event} />
        <KindIcon event={event} />

        <span
          className={cn(
            'truncate',
            event.status === 'error' && 'text-destructive',
            event.status === 'cancelled' && 'text-main-view-fg/50'
          )}
          // The row's own text is visible; the label carries the outcome a sighted
          // reader gets from the icons and the metadata (AH-179).
          aria-label={label}
        >
          {event.title}
        </span>

        <Meta event={event} />

        <span className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {target && onOpenFile && (
            <button
              type="button"
              onClick={() => onOpenFile(target.path, target.line)}
              aria-label={`Open ${target.path}${target.line ? ` at line ${target.line}` : ''}`}
              className="text-main-view-fg/50 hover:text-main-view-fg"
            >
              <ExternalLink className="size-3" aria-hidden />
            </button>
          )}
          {onCopy && (
            <button
              type="button"
              onClick={() => onCopy(copyTextFor(event))}
              aria-label={`Copy details of ${event.title}`}
              className="text-main-view-fg/50 hover:text-main-view-fg"
            >
              <Copy className="size-3" aria-hidden />
            </button>
          )}
        </span>
      </div>

      {expanded && <Detail event={event} />}
    </div>
  )
}

function StatusIcon({ event }: { event: ActivityEvent }) {
  const common = 'size-3 shrink-0'
  switch (event.status) {
    case 'pending':
      return <Loader2 className={cn(common, 'animate-spin text-accent')} aria-hidden />
    case 'ok':
      return <CheckCircle2 className={cn(common, 'text-main-view-fg/40')} aria-hidden />
    case 'error':
      return <XCircle className={cn(common, 'text-destructive')} aria-hidden />
    case 'cancelled':
      return <CircleSlash className={cn(common, 'text-main-view-fg/40')} aria-hidden />
  }
}

function KindIcon({ event }: { event: ActivityEvent }) {
  const common = 'size-3 shrink-0 text-main-view-fg/40'
  switch (event.kind) {
    case 'file.read':
      return <FileSearch className={common} aria-hidden />
    case 'file.created':
      return <FilePlus className={common} aria-hidden />
    case 'file.edited':
    case 'file.moved':
      return <FilePen className={common} aria-hidden />
    case 'file.deleted':
      return <FileX className={common} aria-hidden />
    case 'git':
      return <GitBranch className={common} aria-hidden />
    case 'permission.requested':
    case 'permission.decided':
      return <ShieldQuestion className={common} aria-hidden />
    case 'verification':
      return <TriangleAlert className={common} aria-hidden />
    default:
      return <Terminal className={common} aria-hidden />
  }
}

/** The numbers that let a reader judge a row without expanding it. */
function Meta({ event }: { event: ActivityEvent }) {
  const parts: string[] = []
  const d = event.detail
  if (d.kind === 'change') {
    if (d.change.added !== undefined || d.change.removed !== undefined) {
      parts.push(`+${d.change.added ?? 0} −${d.change.removed ?? 0}`)
    }
  }
  if (d.kind === 'read' && d.read.fromLine !== undefined) {
    parts.push(`L${d.read.fromLine}${d.read.toLine ? `–${d.read.toLine}` : ''}`)
  }
  if (d.kind === 'command' || d.kind === 'verification') {
    const c = d.kind === 'command' ? d.command : d.verification
    if (c.exitCode !== undefined && c.exitCode !== 0) parts.push(`exit ${c.exitCode}`)
    if (c.durationMs !== undefined) parts.push(formatDuration(c.durationMs))
    if (c.background) parts.push('background')
  }
  if (d.kind === 'verification') {
    const v = d.verification
    if (v.failed) parts.push(`${v.failed} failed`)
    if (v.passed) parts.push(`${v.passed} passed`)
  }
  if (d.kind === 'permission' && d.permission.decision) {
    parts.push(d.permission.decision.replace(/_/g, ' '))
  }
  if (d.kind === 'git' && d.git.destructive) parts.push('destructive')
  if (parts.length === 0) return null
  return (
    <span className="shrink-0 text-main-view-fg/40 tabular-nums">
      {parts.join(' · ')}
    </span>
  )
}

/** What an expanded row shows: the diff, the output, or the resource. */
function Detail({ event }: { event: ActivityEvent }) {
  const d = event.detail
  if (d.kind === 'change' && d.change.diff) {
    return (
      <pre className="mb-1 ml-8 overflow-x-auto rounded bg-main-view-fg/5 p-2 font-mono text-[11px] leading-relaxed">
        {d.change.diff.split('\n').map((line, index) => (
          <span
            key={index}
            className={cn(
              'block',
              line.startsWith('+') && 'text-emerald-500',
              line.startsWith('-') && 'text-destructive'
            )}
          >
            {line}
          </span>
        ))}
      </pre>
    )
  }
  if (d.kind === 'command' || d.kind === 'verification') {
    const c = d.kind === 'command' ? d.command : d.verification
    const output = [c.stdout, c.stderr].filter(Boolean).join('\n')
    const lines = output.split('\n')
    const shown = lines.slice(-MAX_EXPANDED_LINES)
    return (
      <div className="mb-1 ml-8 space-y-1">
        <p className="font-mono text-[11px] text-main-view-fg/60">
          {c.cwd ? `${c.cwd} $ ` : '$ '}
          {c.command}
        </p>
        {output && (
          <pre className="max-h-60 overflow-auto rounded bg-main-view-fg/5 p-2 font-mono text-[11px]">
            {shown.length < lines.length && (
              <span className="block text-main-view-fg/40">
                … {lines.length - shown.length} earlier lines
              </span>
            )}
            {shown.join('\n')}
          </pre>
        )}
        {c.outputTruncated && (
          <p className="text-main-view-fg/40">
            Output was truncated when it was recorded.
          </p>
        )}
      </div>
    )
  }
  if (d.kind === 'permission' && d.permission.resource) {
    return (
      <p className="mb-1 ml-8 font-mono text-[11px] text-main-view-fg/60">
        {d.permission.resource}
      </p>
    )
  }
  if (d.kind === 'read' && d.read.fromLine !== undefined) {
    return (
      <p className="mb-1 ml-8 text-main-view-fg/60">
        {d.read.path}:{d.read.fromLine}
        {d.read.toLine ? `–${d.read.toLine}` : ''}
        {d.read.truncated ? ' (truncated)' : ''}
      </p>
    )
  }
  return null
}
