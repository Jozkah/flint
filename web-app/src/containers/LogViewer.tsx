import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import { Check, Copy, X } from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import {
  EnginePage,
  KpiRow,
  KpiTile,
  PageHead,
  SearchField,
} from '@/containers/engine/EngineKit'
import { Segmented } from '@/components/ui/segmented'
import { useServiceHub } from '@/hooks/useServiceHub'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { LogEntry } from '@/services/app/types'
import { cn } from '@/lib/utils'
import { LOG_LEVEL_FILTERS, type LogLevelFilter } from '@/lib/logFilter'
import { SystemPageHeader } from '@/containers/SystemPageHeader'
import { useHeaderSlot } from '@/components/shell/HeaderSlot'

/** Level colours from the semantic tokens; everything else reads as neutral. */
function logLevelClass(level: string): string {
  switch (level) {
    case 'error':
      return 'text-destructive'
    case 'warn':
      return 'text-warning'
    case 'info':
      return 'text-secondary-foreground'
    default:
      return 'text-subtle-foreground'
  }
}

/** Time of day in UTC, 24-hour, as the log file records it. */
function formatLogTimestamp(timestamp: string | number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** One line as plain text, the way it is shown. */
const logAsText = (log: LogEntry) =>
  `[${formatLogTimestamp(log.timestamp)}] ${log.level.toUpperCase()} ${log.message}`

/** The lines as plain text, oldest first as the file has them. */
function logsAsText(logs: LogEntry[]): string {
  return logs.map(logAsText).join('\n')
}

/**
 * The short name of the module a line came from: the last segment of its
 * Rust target (`app_lib::core::server::proxy` is "proxy"), or "app".
 */
function logSource(log: Pick<LogEntry, 'target'>): string {
  const parts = (log.target ?? '').split('::').filter(Boolean)
  return parts[parts.length - 1] ?? 'app'
}

/** The source as a quiet mono label; the level is the only colour on a line. */
function SourceTag({ source, title }: { source: string; title?: string }) {
  return (
    <span
      title={title}
      className="block min-w-0 truncate font-mono text-[11.5px] text-muted-foreground"
    >
      {source}
    </span>
  )
}

const LEVEL_LABEL_KEY: Record<LogLevelFilter, string> = {
  all: 'logs:levelAll',
  error: 'logs:levelError',
  warn: 'logs:levelWarn',
  info: 'logs:levelInfo',
  debug: 'logs:levelDebug',
}

/** Search and level filter above a log viewer. */
export function LogToolbar({
  query,
  onQueryChange,
  level,
  onLevelChange,
  shown,
  total,
  children,
}: {
  query: string
  onQueryChange: (query: string) => void
  level: LogLevelFilter
  onLevelChange: (level: LogLevelFilter) => void
  shown: number
  total: number
  /** Extra filters shown after the level control (the source filter). */
  children?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2.5 px-3 pt-3 pb-2"
      data-testid="log-toolbar"
    >
      <SearchField
        value={query}
        onChange={onQueryChange}
        placeholder={t('logs:search')}
        className="w-full sm:w-60"
      />
      <Segmented<LogLevelFilter>
        size="sm"
        className="w-full sm:w-[440px]"
        aria-label={t('logs:filterLabel')}
        value={level}
        onValueChange={onLevelChange}
        options={LOG_LEVEL_FILTERS.map((value) => ({
          value,
          label: t(LEVEL_LABEL_KEY[value]),
        }))}
      />
      {children}
      <span
        className="ml-auto text-xs tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        {t('logs:shown', { shown, total })}
      </span>
    </div>
  )
}

/** One line: time, level, source and message; opens to show every field. */
function LogRow({ log, fresh }: { log: LogEntry; fresh: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const source = logSource(log)
  return (
    <div
      className={cn(
        'border-b border-dashed border-border last:border-b-0',
        fresh && 'motion-safe:animate-msg-in'
      )}
    >
      <div className="group/lg grid min-h-9 grid-cols-[64px_64px_88px_minmax(0,1fr)_26px] items-center gap-x-3 px-3 text-[12.5px] transition-colors hover:bg-hover-row max-sm:grid-cols-[58px_56px_minmax(0,1fr)_26px]">
        <button
          type="button"
          aria-expanded={open}
          title={t('logs:details')}
          onClick={() => setOpen((o) => !o)}
          className="col-span-4 grid min-h-[34px] cursor-pointer grid-cols-subgrid items-center text-left outline-hidden focus-visible:bg-hover-row max-sm:col-span-3"
        >
        <span className="text-[11.5px] tabular-nums text-muted-foreground">
          {formatLogTimestamp(log.timestamp)}
        </span>
        <span
          className={cn(
            'flex items-center gap-1.5 text-[11.5px] font-medium capitalize',
            logLevelClass(log.level)
          )}
        >
          <i aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
          {log.level}
        </span>
        <span className="min-w-0 max-sm:hidden">
          <SourceTag source={source} title={log.target} />
        </span>
        <span
          className={cn(
            'min-w-0 font-mono text-xs text-foreground',
            open ? 'break-words whitespace-pre-wrap' : 'truncate whitespace-pre'
          )}
        >
          {log.message}
        </span>
        </button>
        <button
          type="button"
          aria-label={t('logs:copyLine')}
          onClick={() => {
            void navigator.clipboard?.writeText(logAsText(log)).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
          className="grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/lg:opacity-100 hover:bg-hover-btn hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      {open && (
        <pre className="mx-3 mb-2.5 ml-3 overflow-x-auto rounded-lg bg-code-bg px-3 py-2.5 font-mono text-[11.5px] leading-[1.55] text-fg-2 shadow-[inset_0_0_0_0.8px_var(--border)] motion-safe:animate-rise-in sm:ml-[244px]">
          {JSON.stringify(
            {
              time: formatLogTimestamp(log.timestamp),
              level: log.level,
              source: log.target || source,
              message: log.message,
            },
            null,
            2
          )}
        </pre>
      )}
    </div>
  )
}

/**
 * Log lines, newest first, on the card surface. Long lines are cut to one row
 * until opened, so the list never scrolls sideways. While `follow` is on, a
 * new line brings the list back to the top where it appears.
 */
export function LogViewer({
  logs,
  emptyText,
  ref,
  follow = true,
  className,
}: {
  logs: LogEntry[]
  emptyText: string
  ref?: Ref<HTMLDivElement>
  follow?: boolean
  className?: string
}) {
  const innerRef = useRef<HTMLDivElement | null>(null)
  const newest = useMemo(() => [...logs].reverse(), [logs])
  const seen = useRef(logs.length)
  const added = Math.max(0, logs.length - seen.current)
  useEffect(() => {
    if (follow && logs.length > seen.current && innerRef.current)
      innerRef.current.scrollTop = 0
    seen.current = logs.length
  }, [logs.length, follow])

  return (
    <div
      ref={(el) => {
        innerRef.current = el
        if (typeof ref === 'function') ref(el)
        else if (ref) (ref as { current: HTMLDivElement | null }).current = el
      }}
      data-testid="log-viewer"
      role="log"
      className={cn(
        'min-h-0 w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto text-foreground select-text [scrollbar-width:thin]',
        className
      )}
    >
      {logs.length === 0 ? (
        <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        newest.map((log, index) => (
          <LogRow
            key={logs.length - index}
            log={log}
            fresh={index < added && index < 5}
          />
        ))
      )}
    </div>
  )
}

/** Copies every line shown in the viewer. */
export function CopyLogsButton({ logs }: { logs: LogEntry[] }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logsAsText(logs))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy logs:', error)
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="pointer-coarse:h-11"
      disabled={logs.length === 0}
      onClick={() => void copy()}
      data-testid="copy-logs"
    >
      {copied ? <Check /> : <Copy />}
      {copied ? t('logs:copied') : t('logs:copy')}
    </Button>
  )
}

/* ---------------- the Logs page ---------------- */

const HOUR = 3_600_000

const toTime = (ts: string | number) => new Date(ts).getTime()

type Bucket = { start: number; info: number; warn: number; error: number }

/** Lines per hour over the last day, split by level, newest bucket last. */
function hourBuckets(logs: LogEntry[], now: number): Bucket[] {
  const end = Math.floor(now / HOUR) * HOUR + HOUR
  const buckets: Bucket[] = Array.from({ length: 24 }, (_, i) => ({
    start: end - (24 - i) * HOUR,
    info: 0,
    warn: 0,
    error: 0,
  }))
  for (const log of logs) {
    const i = Math.floor((toTime(log.timestamp) - (end - 24 * HOUR)) / HOUR)
    if (i < 0 || i > 23 || Number.isNaN(i)) continue
    const b = buckets[i]
    if (log.level === 'error') b.error++
    else if (log.level === 'warn') b.warn++
    else b.info++
  }
  return buckets
}

const hourLabel = (ms: number) =>
  new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

/**
 * Lines per hour over the last day. Each bar is one neutral column; warnings
 * and errors are the only colour, stacked on top in the semantic tokens.
 */
function ActivityChart({ logs }: { logs: LogEntry[] }) {
  const { t } = useTranslation()
  const buckets = useMemo(() => hourBuckets(logs, Date.now()), [logs])
  const max = Math.max(1, ...buckets.map((b) => b.info + b.warn + b.error))
  const any = buckets.some((b) => b.info + b.warn + b.error > 0)
  return (
    <div className="flex flex-col">
      <div className="relative flex h-36 items-end gap-[3px]">
        {!any && (
          <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            {t('logs:activityEmpty')}
          </p>
        )}
        {buckets.map((b, i) => {
          const total = b.info + b.warn + b.error
          const tip = t('logs:activityBar', {
            time: hourLabel(b.start),
            info: b.info,
            warn: b.warn,
            error: b.error,
          })
          return (
            <div
              key={b.start}
              title={tip}
              aria-label={tip}
              className="flex h-full flex-1 items-end rounded-[4px] bg-muted/60"
            >
              {total > 0 && (
                <div
                  className="flex w-full origin-bottom flex-col overflow-hidden rounded-[4px] motion-safe:animate-grow-y"
                  style={{
                    height: `${Math.max(4, (total / max) * 100)}%`,
                    animationDelay: `${i * 20}ms`,
                  }}
                >
                  {b.error > 0 && (
                    <i className="block bg-destructive/80" style={{ flexGrow: b.error }} />
                  )}
                  {b.warn > 0 && (
                    <i className="block bg-warning/80" style={{ flexGrow: b.warn }} />
                  )}
                  {b.info > 0 && (
                    <i className="block bg-sk-2" style={{ flexGrow: b.info }} />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex justify-between text-[11px] tabular-nums text-muted-foreground">
        {[0, 6, 12, 18].map((i) => (
          <span key={i}>{hourLabel(buckets[i].start)}</span>
        ))}
        <span>{t('logs:now')}</span>
      </div>
    </div>
  )
}

function ActivityLegend() {
  const { t } = useTranslation()
  return (
    <span className="flex items-center gap-3 text-[11.5px] text-muted-foreground">
      {(
        [
          ['bg-sk-2', 'logs:levelInfo'],
          ['bg-warning/80', 'logs:levelWarn'],
          ['bg-destructive/80', 'logs:levelError'],
        ] as const
      ).map(([cls, key]) => (
        <span key={key} className="flex items-center gap-1.5">
          <i className={cn('size-2 rounded-[2px]', cls)} />
          {t(key)}
        </span>
      ))}
    </span>
  )
}

/**
 * The Logs page shared by the app log and the Local API Server log: headline
 * numbers, activity over the day, the busiest sources (each one a filter),
 * and the lines themselves with search, level and source filters.
 *
 * Inside the shell it is an engine page like Models or Library. In the logs'
 * own window the title and actions move to the bar SystemPageHeader draws.
 */
export function LogsDashboard({
  title,
  description,
  fileName,
  logs,
}: {
  title: string
  description: string
  /** Shown on the lines' frame, e.g. `app.log`. */
  fileName: string
  logs: LogEntry[]
}) {
  const { t } = useTranslation()
  const inShell = useHeaderSlot() !== null
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState<LogLevelFilter>('all')
  const [source, setSource] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const [frozen, setFrozen] = useState<LogEntry[]>([])

  // Paused, the list holds still on what was there; the numbers stay live.
  const lines = follow ? logs : frozen

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return lines.filter(
      (log) =>
        (level === 'all' || log.level === level) &&
        (!source || logSource(log) === source) &&
        (!q ||
          log.message.toLowerCase().includes(q) ||
          (log.target ?? '').toLowerCase().includes(q))
    )
  }, [lines, query, level, source])

  const stats = useMemo(() => {
    const hourAgo = Date.now() - HOUR
    const today = new Date().toDateString()
    let todayLines = 0
    let errors = 0
    let warnings = 0
    let recentErrors = 0
    const sources = new Map<string, number>()
    const warnSources = new Map<string, number>()
    for (const log of logs) {
      const at = toTime(log.timestamp)
      if (new Date(at).toDateString() === today) todayLines++
      const s = logSource(log)
      if (log.level === 'error') {
        errors++
        if (at >= hourAgo) recentErrors++
      } else if (log.level === 'warn') {
        warnings++
        warnSources.set(s, (warnSources.get(s) ?? 0) + 1)
      }
      sources.set(s, (sources.get(s) ?? 0) + 1)
    }
    const top = [...sources.entries()].sort((a, b) => b[1] - a[1])
    const topWarn = [...warnSources.entries()].sort((a, b) => b[1] - a[1])[0]
    return { todayLines, errors, warnings, recentErrors, top, topWarn: topWarn?.[0] }
  }, [logs])

  const serviceHub = useServiceHub()
  const openFolder = async () => {
    try {
      const folder = await serviceHub.app().getJanDataFolder()
      if (!folder) return
      await serviceHub.opener().openPath(await serviceHub.path().join(folder, 'logs'))
    } catch (error) {
      console.error('Failed to open the logs folder:', error)
    }
  }

  const actions = (
    <>
      <CopyLogsButton logs={shown} />
      <Button
        variant="outline"
        size="sm"
        className="pointer-coarse:h-11"
        onClick={() => void openFolder()}
        data-testid="open-logs-folder"
      >
        <Icon name="x-folder" size={14} />
        {t('logs:openFolder')}
      </Button>
    </>
  )
  const topMax = stats.top[0]?.[1] ?? 1

  const body = (
    <>
      {inShell ? (
        <PageHead title={title} description={description} actions={actions} />
      ) : (
        <p className="text-[13px] text-muted-foreground">{description}</p>
      )}

      <KpiRow>
        <KpiTile
          title={t('logs:kpiLines')}
          icon={<Icon name="sb-file" size={16} />}
          value={logs.length.toLocaleString()}
          sub={t('logs:kpiLinesToday', { count: stats.todayLines })}
          delay={40}
        />
        <KpiTile
          title={t('logs:kpiErrors')}
          icon={<Icon name="x-shield" size={16} />}
          value={stats.errors.toLocaleString()}
          sub={t('logs:kpiLastHour', { count: stats.recentErrors })}
          delay={80}
        />
        <KpiTile
          title={t('logs:kpiWarnings')}
          icon={<Icon name="feed-alert" size={16} />}
          value={stats.warnings.toLocaleString()}
          sub={
            stats.topWarn
              ? t('logs:kpiWarningsSub', { name: stats.topWarn })
              : t('logs:kpiWarningsNone')
          }
          delay={120}
        />
        <KpiTile
          title={t('logs:kpiSources')}
          icon={<Icon name="flow" size={16} />}
          value={String(stats.top.length)}
          sub={
            stats.top[0]
              ? t('logs:kpiSourcesSub', { name: stats.top[0][0] })
              : t('logs:kpiSourcesNone')
          }
          delay={160}
        />
      </KpiRow>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Frame className="motion-safe:animate-rise-in" style={{ animationDelay: '200ms' }}>
          <FrameHeader
            icon={<Icon name="analytics" size={16} />}
            title={t('logs:activity')}
            actions={<ActivityLegend />}
          />
          <FrameBody className="p-3.5">
            <ActivityChart logs={logs} />
          </FrameBody>
        </Frame>
        <Frame className="motion-safe:animate-rise-in" style={{ animationDelay: '240ms' }}>
          <FrameHeader icon={<Icon name="flow" size={16} />} title={t('logs:topSources')} />
          <FrameBody className="gap-0 p-1.5">
            {stats.top.length === 0 && (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                {t('logs:kpiSourcesNone')}
              </p>
            )}
            {stats.top.slice(0, 6).map(([name, n]) => {
              const on = source === name
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={on}
                  title={t('logs:filterSource', { name })}
                  onClick={() => setSource(on ? null : name)}
                  className={cn(
                    'grid grid-cols-[80px_minmax(0,1fr)_32px] items-center gap-3 rounded-lg px-2 py-[7px] text-left transition-colors outline-hidden hover:bg-hover-row focus-visible:ring-[3px] focus-visible:ring-ring/40',
                    on && 'bg-hover-row'
                  )}
                >
                  <span
                    className={cn(
                      'truncate font-mono text-xs',
                      on ? 'font-medium text-foreground' : 'text-secondary-foreground'
                    )}
                  >
                    {name}
                  </span>
                  <span className="h-1.5 w-full overflow-hidden rounded-full bg-track">
                    <i
                      className="block h-full rounded-full bg-sk-2 motion-safe:animate-draw-x"
                      style={{ width: `${(n / topMax) * 100}%` }}
                    />
                  </span>
                  <b className="text-right text-xs font-medium tabular-nums text-foreground">
                    {n}
                  </b>
                </button>
              )
            })}
          </FrameBody>
        </Frame>
      </div>

      <Frame className="motion-safe:animate-rise-in" style={{ animationDelay: '280ms' }}>
        <FrameHeader
          icon={<Icon name="x-terminal" size={16} />}
          title={<span className="font-mono">{fileName}</span>}
          actions={
            <>
              <Chip tone={follow ? 'ok' : 'neutral'} dot live={follow}>
                {follow ? t('logs:following') : t('logs:paused')}
              </Chip>
              <Button
                variant="ghost"
                size="sm"
                className="pointer-coarse:h-11"
                onClick={() => {
                  if (follow) setFrozen(logs)
                  setFollow(!follow)
                }}
              >
                {follow ? t('logs:pause') : t('logs:follow')}
              </Button>
            </>
          }
        />
        <FrameBody className="overflow-hidden p-0">
          {logs.length > 0 && (
            <LogToolbar
              query={query}
              onQueryChange={setQuery}
              level={level}
              onLevelChange={setLevel}
              shown={shown.length}
              total={lines.length}
            >
              {source && (
                <button
                  type="button"
                  onClick={() => setSource(null)}
                  aria-label={t('logs:clearSource')}
                  className="inline-flex h-7 items-center gap-1.5 rounded-lg border-[0.8px] border-border bg-card px-2.5 font-mono text-xs text-secondary-foreground hover:bg-hover-row"
                >
                  {source}
                  <X className="size-3" aria-hidden />
                </button>
              )}
            </LogToolbar>
          )}
          <LogViewer
            logs={shown}
            follow={follow}
            className="max-h-[62vh] min-h-[240px] border-t border-dashed border-border"
            emptyText={logs.length === 0 ? t('logs:noLogs') : t('logs:noMatch')}
          />
        </FrameBody>
      </Frame>
    </>
  )

  if (inShell) return <EnginePage testId="logs-page">{body}</EnginePage>

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-card">
      <SystemPageHeader title={title} icon={<Icon name="sb-file" size={16} />} actions={actions} />
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pt-4 pb-8 [scrollbar-width:thin]">
        <div className="flex w-full min-w-0 flex-col gap-6">{body}</div>
      </div>
    </div>
  )
}
