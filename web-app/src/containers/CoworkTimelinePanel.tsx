import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock,
  Hand,
  Loader2,
  PauseCircle,
  XCircle,
} from 'lucide-react'
import { CoworkSidePanel } from '@/containers/CoworkSidePanel'
import { DiffView } from '@/components/DiffView'
import { TokenUsageBreakdown } from '@/components/TokenUsageBreakdown'
import { CacheReuseBadge } from '@/components/CacheReuseBadge'
import { listEvents, type EventEnvelope } from '@/lib/eventLog'
import { loadToolDiff } from '@/lib/toolActivity'
import { parseUnifiedDiff } from '@/lib/unifiedDiff'
import {
  buildTimeline,
  countByCategory,
  filterTimeline,
  TIMELINE_CATEGORIES,
  type TimelineCategory,
  type TimelineRow,
  type TimelineStatus,
} from '@/lib/executionTimeline'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** Rows drawn in full below this; above it the list is virtualized. */
export const TIMELINE_FULL_RENDER_LIMIT = 200
/** How often the open panel reads new events while a run is going. */
const POLL_MS = 1500

const STATUS_ICON: Record<TimelineStatus, React.ReactNode> = {
  running: <Loader2 className="size-3.5 animate-spin" aria-hidden />,
  queued: <Clock className="size-3.5" aria-hidden />,
  awaiting: <Hand className="size-3.5" aria-hidden />,
  completed: <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden />,
  failed: <XCircle className="size-3.5 text-destructive" aria-hidden />,
  refused: <Ban className="size-3.5 text-amber-600" aria-hidden />,
  cancelled: <CircleDot className="size-3.5 text-muted-foreground" aria-hidden />,
  interrupted: <PauseCircle className="size-3.5 text-amber-600" aria-hidden />,
}

const time = (at: string) => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleTimeString()
}

/**
 * The session's execution timeline, from its canonical event log.
 *
 * Chronological, one row per call or event, compact until opened. Follows new
 * events while the list is scrolled to its end; scrolling up pauses that until
 * "Follow live" is pressed. Rows are reachable with the arrow keys, Home and
 * End; each carries its status in words for a screen reader. Long runs are
 * virtualized rather than drawn whole.
 */
export function CoworkTimelinePanel({
  sessionId,
  running,
  onClose,
}: {
  sessionId: string
  running: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [events, setEvents] = useState<EventEnvelope[]>([])
  const [error, setError] = useState<string | null>(null)
  const [enabled, setEnabled] = useState<Set<TimelineCategory>>(
    () => new Set(TIMELINE_CATEGORIES)
  )
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [following, setFollowing] = useState(true)
  const [linked, setLinked] = useState<string | null>(null)
  const lastSeq = useRef(0)
  const session = useRef(sessionId)
  const listRef = useRef<HTMLDivElement>(null)

  // Another session: nothing of the previous one survives, and a page that
  // arrives late for it is dropped.
  useEffect(() => {
    session.current = sessionId
    lastSeq.current = 0
    setEvents([])
    setError(null)
    setExpanded(new Set())
    setLinked(null)
    setFollowing(true)
  }, [sessionId])

  const read = useCallback(async () => {
    const asked = sessionId
    try {
      const page = await listEvents(asked, lastSeq.current)
      if (session.current !== asked) return
      if (page.events.length > 0) {
        lastSeq.current = page.events[page.events.length - 1].seq
        setEvents((prev) => [...prev, ...page.events])
      }
      setError(null)
    } catch (e) {
      if (session.current === asked) setError(String(e))
    }
  }, [sessionId])

  useEffect(() => {
    void read()
    if (!running) return
    const timer = setInterval(() => void read(), POLL_MS)
    return () => clearInterval(timer)
  }, [read, running])
  // One last read when a run ends, for its final events.
  useEffect(() => {
    if (!running) void read()
  }, [running, read])

  const rows = useMemo(() => buildTimeline(events, sessionId), [events, sessionId])
  const counts = useMemo(() => countByCategory(rows), [rows])
  const visible = useMemo(() => filterTimeline(rows, enabled), [rows, enabled])
  const virtual = visible.length > TIMELINE_FULL_RENDER_LIMIT

  const virtualizer = useVirtualizer({
    count: virtual ? visible.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => 44,
    overscan: 12,
  })

  // Follow live: stay at the end while following.
  useEffect(() => {
    if (!following) return
    const el = listRef.current
    if (!el) return
    if (virtual) virtualizer.scrollToIndex(visible.length - 1, { align: 'end' })
    else el.scrollTop = el.scrollHeight
  }, [visible.length, following, virtual, virtualizer])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (!atEnd && following) setFollowing(false)
  }

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-row-toggle]') ?? []),
    ]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let next = -1
    if (e.key === 'ArrowDown') next = Math.min(at + 1, buttons.length - 1)
    else if (e.key === 'ArrowUp') next = Math.max(at - 1, 0)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = buttons.length - 1
    if (next >= 0 && buttons[next]) {
      e.preventDefault()
      buttons[next].focus()
      if (!virtual) buttons[next].scrollIntoView?.({ block: 'nearest' })
    }
  }

  const renderRow = (row: TimelineRow, index: number) => (
    <TimelineItem
      key={row.id}
      row={row}
      index={index}
      total={visible.length}
      sessionId={sessionId}
      open={expanded.has(row.id)}
      onToggle={() => toggle(row.id)}
      linked={!!linked && row.invocation === linked}
      onLink={(inv) => setLinked((cur) => (cur === inv ? null : inv))}
    />
  )

  return (
    <CoworkSidePanel
      title={t('common:timeline.title')}
      summary={
        <span className="shrink-0 font-mono text-xs tabular-nums text-main-view-fg/60">
          {t('common:timeline.count', { count: rows.length })}
        </span>
      }
      onClose={onClose}
      data-testid="timeline-panel"
    >
      <div className="flex h-full min-h-0 flex-col" data-session={sessionId}>
        <div
          role="group"
          aria-label={t('common:timeline.filters')}
          className="flex flex-wrap gap-1 border-b px-2 py-1.5"
        >
          {TIMELINE_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={enabled.has(c)}
              data-testid={`timeline-filter-${c}`}
              onClick={() =>
                setEnabled((prev) => {
                  const next = new Set(prev)
                  if (next.has(c)) next.delete(c)
                  else next.add(c)
                  return next
                })
              }
              className={cn(
                'rounded border px-1.5 py-0.5 text-[11px]',
                enabled.has(c) ? 'bg-muted text-foreground' : 'text-muted-foreground line-through'
              )}
            >
              {t(`common:timeline.category.${c}`)} {counts[c]}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between border-b px-2 py-1 text-[11px] text-muted-foreground">
          <span aria-live="polite" data-testid="timeline-live-state">
            {following ? t('common:timeline.following') : t('common:timeline.paused')}
          </span>
          {!following && (
            <button
              type="button"
              data-testid="timeline-follow"
              className="rounded border px-1.5 py-0.5 text-foreground"
              onClick={() => setFollowing(true)}
            >
              {t('common:timeline.followLive')}
            </button>
          )}
          {linked && (
            <button
              type="button"
              data-testid="timeline-unlink"
              className="rounded border px-1.5 py-0.5"
              onClick={() => setLinked(null)}
            >
              {t('common:timeline.clearLink')}
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="px-3 py-2 text-xs text-destructive" data-testid="timeline-error">
            {t('common:timeline.unreadable', { error })}
          </p>
        )}
        <div
          ref={listRef}
          role="feed"
          aria-busy={running}
          aria-label={t('common:timeline.title')}
          tabIndex={-1}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          className="min-h-0 flex-1 overflow-y-auto"
          data-testid="timeline-list"
          data-virtual={virtual}
        >
          {visible.length === 0 && !error && (
            <p className="px-3 py-4 text-xs text-muted-foreground">{t('common:timeline.empty')}</p>
          )}
          {virtual ? (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((v) => (
                <div
                  key={visible[v.index].id}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
                >
                  {renderRow(visible[v.index], v.index)}
                </div>
              ))}
            </div>
          ) : (
            visible.map((row, i) => renderRow(row, i))
          )}
        </div>
      </div>
    </CoworkSidePanel>
  )
}

function TimelineItem({
  row,
  index,
  total,
  sessionId,
  open,
  onToggle,
  linked,
  onLink,
}: {
  row: TimelineRow
  index: number
  total: number
  sessionId: string
  open: boolean
  onToggle: () => void
  linked: boolean
  onLink: (invocation: string) => void
}) {
  const { t } = useTranslation()
  const status = t(`common:timeline.status.${row.status}`)
  return (
    <article
      aria-posinset={index + 1}
      aria-setsize={total}
      aria-label={`${row.title}, ${status}`}
      data-testid="timeline-row"
      data-status={row.status}
      data-category={row.primary}
      data-categories={row.categories.join(' ')}
      data-invocation={row.invocation ?? ''}
      data-seq={row.seq}
      data-linked={linked}
      className={cn('border-b', linked && 'bg-primary/5')}
    >
      <div className="flex items-start gap-1 px-2 py-1.5">
        <button
          type="button"
          data-row-toggle
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <span className="pt-0.5">{STATUS_ICON[row.status]}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{row.title}</span>
            <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
              <span data-testid="timeline-row-status">{status}</span>
              <span>{t(`common:timeline.category.${row.primary}`)}</span>
              <span className="font-mono tabular-nums">{time(row.at)}</span>
              {row.agent && row.agent !== 'main' && <span>{row.agent}</span>}
              {row.change && (
                <span className="font-mono tabular-nums" data-testid="timeline-row-counts">
                  +{row.change.added ?? 0} −{row.change.removed ?? 0}
                </span>
              )}
              {row.usage && <CacheReuseBadge usage={row.usage} hideUnreported />}
            </span>
          </span>
          <ChevronDown
            size={12}
            aria-hidden
            className={cn('mt-1 shrink-0 transition-transform', !open && '-rotate-90')}
          />
        </button>
        {row.invocation && (
          <button
            type="button"
            data-testid="timeline-invocation"
            aria-pressed={linked}
            title={t('common:timeline.linkHint')}
            onClick={() => onLink(row.invocation!)}
            className="shrink-0 rounded border px-1 font-mono text-[10px] text-muted-foreground"
          >
            {row.invocation.slice(-8)}
          </button>
        )}
      </div>
      {open && <TimelineDetail row={row} sessionId={sessionId} />}
    </article>
  )
}

function TimelineDetail({ row, sessionId }: { row: TimelineRow; sessionId: string }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5 px-3 pb-2 text-[11px]" data-testid="timeline-detail">
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-muted-foreground">
        {row.call && (
          <>
            <dt>{t('common:timeline.call')}</dt>
            <dd className="font-mono break-all">{row.call}</dd>
          </>
        )}
        {row.invocation && (
          <>
            <dt>{t('common:timeline.invocation')}</dt>
            <dd className="font-mono break-all" data-testid="timeline-detail-invocation">
              {row.invocation}
            </dd>
          </>
        )}
        {row.history.length > 0 && (
          <>
            <dt>{t('common:timeline.phases')}</dt>
            <dd>{row.history.join(' → ')}</dd>
          </>
        )}
        {row.elapsedMs !== undefined && (
          <>
            <dt>{t('common:timeline.duration')}</dt>
            <dd className="font-mono">{row.elapsedMs} ms</dd>
          </>
        )}
        {row.exitCode !== undefined && (
          <>
            <dt>{t('common:timeline.exitCode')}</dt>
            <dd className="font-mono">{row.exitCode}</dd>
          </>
        )}
        {row.refusal && (
          <>
            <dt>{t('common:timeline.refusal')}</dt>
            <dd className="font-mono" data-testid="timeline-detail-refusal">
              {row.refusal}
            </dd>
          </>
        )}
      </dl>
      {row.detail && <p className="whitespace-pre-wrap break-words">{row.detail}</p>}
      {row.input && (
        <details>
          <summary>{t('common:timeline.input')}</summary>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-1.5">
            {row.input}
          </pre>
        </details>
      )}
      {row.output !== undefined && (
        <details>
          <summary>
            {t('common:timeline.output')}
            {row.outputTruncated ? ` (${t('common:timeline.truncated')})` : ''}
          </summary>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-1.5">
            {row.output}
          </pre>
        </details>
      )}
      {row.usage && <TokenUsageBreakdown usage={row.usage} testIdPrefix="timeline-usage" />}
      {row.change && row.call && (
        <EditDiff sessionId={sessionId} call={row.call} change={row.change} />
      )}
    </div>
  )
}

/** This edit's own diff, as the backend stored it when the call ended. */
function EditDiff({
  sessionId,
  call,
  change,
}: {
  sessionId: string
  call: string
  change: NonNullable<TimelineRow['change']>
}) {
  const { t } = useTranslation()
  const [diff, setDiff] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let current = true
    if (!change.diffStored) {
      setDiff(null)
      return
    }
    void loadToolDiff(sessionId, call).then((d) => {
      if (current) setDiff(d)
    })
    return () => {
      current = false
    }
  }, [sessionId, call, change.diffStored])
  const hunks = useMemo(() => (diff ? parseUnifiedDiff(diff).hunks.length : 0), [diff])
  return (
    <div data-testid="timeline-diff" data-path={change.path} data-hunks={hunks}>
      <div className="font-mono text-muted-foreground">
        {change.kind} {change.path} · +{change.added ?? 0} −{change.removed ?? 0}
        {diff ? ` · ${t('common:timeline.hunks', { count: hunks })}` : ''}
      </div>
      {change.oversized ? (
        <p className="text-muted-foreground">{t('common:timeline.diffOversized')}</p>
      ) : diff === undefined ? null : diff === null ? (
        <p className="text-muted-foreground">{t('common:timeline.diffUnavailable')}</p>
      ) : (
        <DiffView diff={diff} className="max-h-72 overflow-auto" />
      )}
    </div>
  )
}
