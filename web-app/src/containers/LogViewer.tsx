import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import {
  AlertTriangle,
  BarChart3,
  Check,
  Copy,
  FileText,
  Layers,
  Search,
  ShieldAlert,
  SquareTerminal,
  Waypoints,
  X,
} from 'lucide-react'
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
      return 'text-info'
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

// A fixed set of distinguishable hues; a source always gets the same one.
const SOURCE_COLOURS = [
  '#8b5cf6',
  '#0891b2',
  '#d97706',
  '#2563eb',
  '#e11d48',
  '#059669',
  '#10a37f',
  '#64748b',
]

function sourceColour(source: string): string {
  let h = 0
  for (let i = 0; i < source.length; i++) h = (h * 31 + source.charCodeAt(i)) >>> 0
  return SOURCE_COLOURS[h % SOURCE_COLOURS.length]
}

/** The source as a small tinted mono label. */
function SourceTag({ source, title }: { source: string; title?: string }) {
  const c = sourceColour(source)
  return (
    <span
      title={title}
      className="inline-flex h-5 max-w-full min-w-0 items-center justify-center truncate rounded-md px-2 font-mono text-[11px] font-medium"
      style={{ color: c, background: `color-mix(in oklab, ${c} 13%, transparent)` }}
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
  const index = Math.max(0, LOG_LEVEL_FILTERS.indexOf(level))
  const count = LOG_LEVEL_FILTERS.length
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-3 border-b border-dashed border-border px-3 py-2.5"
      data-testid="log-toolbar"
    >
      <label className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border-[0.8px] border-border bg-card px-2.5 transition-[border-color,box-shadow] focus-within:border-border-strong focus-within:ring-[3px] focus-within:ring-ring/20 sm:w-60 pointer-coarse:h-11">
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t('logs:search')}
          aria-label={t('logs:search')}
          className="w-full min-w-0 bg-transparent text-[13px] placeholder:text-muted-foreground focus:outline-none"
        />
      </label>
      {/* Pressed buttons under a gliding gradient pill, like every other
          segmented choice in the app. */}
      <div
        role="group"
        aria-label={t('logs:filterLabel')}
        className="relative flex w-full max-w-[400px] gap-2 overflow-x-auto sm:w-[400px]"
      >
        <span
          aria-hidden
          style={{
            width: `calc((100% - ${count - 1} * 0.5rem) / ${count})`,
            left: `calc((100% - ${count - 1} * 0.5rem) / ${count} * ${index} + ${index} * 0.5rem)`,
          }}
          className="pointer-events-none absolute top-0 h-7 rounded-lg border border-primary bg-grad transition-[left] duration-300 ease-expo pointer-coarse:h-10"
        />
        {LOG_LEVEL_FILTERS.map((value) => {
          const pressed = value === level
          return (
            <button
              key={value}
              type="button"
              aria-pressed={pressed}
              onClick={() => onLevelChange(value)}
              className={cn(
                'relative z-10 h-7 min-w-0 flex-1 cursor-pointer rounded-lg border-[0.8px] px-2 text-xs font-medium transition-[color,background-color,border-color,transform] duration-200 ease-expo outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.97] pointer-coarse:h-10',
                pressed
                  ? 'border-transparent bg-transparent text-on-grad'
                  : 'border-border bg-card text-secondary-foreground hover:bg-hover-row'
              )}
            >
              {t(LEVEL_LABEL_KEY[value])}
            </button>
          )
        })}
      </div>
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
        'border-b border-[rgba(127,127,127,.1)]',
        log.level === 'error' &&
          'bg-[color-mix(in_oklab,var(--destructive)_5%,transparent)] shadow-[inset_3px_0_0_var(--destructive)]',
        log.level === 'warn' && 'shadow-[inset_3px_0_0_var(--warning)]',
        fresh && 'motion-safe:animate-msg-in'
      )}
    >
      <div className="group/lg grid min-h-[34px] grid-cols-[70px_58px_96px_minmax(0,1fr)_26px] items-center gap-x-2.5 px-3 text-[12.5px] transition-colors hover:bg-hover-row max-sm:grid-cols-[62px_50px_minmax(0,1fr)_26px]">
        <button
          type="button"
          aria-expanded={open}
          title={t('logs:details')}
          onClick={() => setOpen((o) => !o)}
          className="col-span-4 grid min-h-[34px] cursor-pointer grid-cols-subgrid items-center text-left outline-hidden focus-visible:bg-hover-row max-sm:col-span-3"
        >
        <span className="font-mono text-[11.5px] tabular-nums text-subtle-foreground">
          {formatLogTimestamp(log.timestamp)}
        </span>
        <span
          className={cn(
            'font-mono text-[10.5px] font-semibold tracking-[.03em]',
            logLevelClass(log.level)
          )}
        >
          {log.level.toUpperCase()}
        </span>
        <span className="min-w-0 max-sm:hidden">
          <SourceTag source={source} title={log.target} />
        </span>
        <span
          className={cn(
            'min-w-0 font-mono text-xs text-fg-2',
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
        <pre className="mx-3 mb-2.5 ml-3 overflow-x-auto rounded-lg bg-code-bg px-3 py-2.5 font-mono text-[11.5px] leading-[1.55] text-fg-2 shadow-[inset_0_0_0_0.8px_var(--border)] motion-safe:animate-rise-in sm:ml-[186px]">
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

/** A headline number in a small frame. */
function Kpi({
  title,
  icon,
  value,
  sub,
  delay,
}: {
  title: string
  icon: ReactNode
  value: ReactNode
  sub: ReactNode
  delay: number
}) {
  return (
    <Frame
      className="motion-safe:animate-rise-in"
      style={{ animationDelay: `${delay}ms` }}
    >
      <FrameHeader
        title={title}
        actions={
          <span className="text-muted-foreground [&_svg]:size-4" aria-hidden>
            {icon}
          </span>
        }
      />
      <FrameBody className="min-h-[92px] justify-between gap-2.5 rounded-[10px] border-border p-3">
        <b className="text-2xl leading-none font-medium tabular-nums text-foreground">
          {value}
        </b>
        <span className="truncate text-xs text-muted-foreground">{sub}</span>
      </FrameBody>
    </Frame>
  )
}

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

function ActivityChart({ logs }: { logs: LogEntry[] }) {
  const { t } = useTranslation()
  const buckets = useMemo(() => hourBuckets(logs, Date.now()), [logs])
  const max = Math.max(1, ...buckets.map((b) => b.info + b.warn + b.error))
  const any = buckets.some((b) => b.info + b.warn + b.error > 0)
  return (
    <div className="flex h-full min-h-[150px] flex-col">
      <div className="relative flex h-[120px] items-end gap-1 py-1">
        {!any && (
          <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            {t('logs:activityEmpty')}
          </p>
        )}
        {buckets.map((b, i) => {
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
              className="group/b flex h-full flex-1 flex-col-reverse gap-px"
            >
              {(
                [
                  ['info', 'bg-[linear-gradient(var(--sk2),var(--sk))]'],
                  ['warn', 'bg-warning'],
                  ['error', 'bg-destructive'],
                ] as const
              ).map(([k, cls]) =>
                b[k] > 0 ? (
                  <i
                    key={k}
                    className={cn(
                      'block w-full origin-bottom rounded-[3px] group-hover/b:brightness-115 motion-safe:animate-grow-y',
                      cls
                    )}
                    style={{
                      height: `${(b[k] / max) * 100}%`,
                      animationDelay: `${i * 25}ms`,
                    }}
                  />
                ) : null
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
        {[0, 6, 12, 18].map((i) => (
          <span key={i}>{hourLabel(buckets[i].start)}</span>
        ))}
        <span>{t('logs:now')}</span>
      </div>
    </div>
  )
}

/**
 * The Logs page shared by the app log and the Local API Server log: headline
 * numbers, activity over the day, the busiest sources (each one a filter),
 * and the lines themselves with search, level and source filters.
 *
 * It renders inside the shell and in the logs' own window; there the page
 * title and actions move to the standalone bar that SystemPageHeader draws.
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
    let errors = 0
    let warnings = 0
    let recentErrors = 0
    let recentWarnings = 0
    const sources = new Map<string, number>()
    for (const log of logs) {
      const recent = toTime(log.timestamp) >= hourAgo
      if (log.level === 'error') {
        errors++
        if (recent) recentErrors++
      } else if (log.level === 'warn') {
        warnings++
        if (recent) recentWarnings++
      }
      const s = logSource(log)
      sources.set(s, (sources.get(s) ?? 0) + 1)
    }
    const top = [...sources.entries()].sort((a, b) => b[1] - a[1])
    return { errors, warnings, recentErrors, recentWarnings, top }
  }, [logs])

  const copy = <CopyLogsButton logs={shown} />
  const topMax = stats.top[0]?.[1] ?? 1

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-card">
      <SystemPageHeader
        title={title}
        icon={<FileText className="size-4" />}
        actions={inShell ? undefined : copy}
      />
      <div
        className={cn(
          'min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 pb-8 [scrollbar-width:thin]',
          inShell ? 'px-1' : 'px-4'
        )}
      >
        <div className="flex w-full min-w-0 flex-col gap-4">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-3">
              {inShell && (
                <h2 className="text-[22px] leading-none font-medium tracking-[-0.01em] text-foreground">
                  {title}
                </h2>
              )}
              <p className="text-[13px] text-muted-foreground">{description}</p>
            </div>
            {inShell && copy}
          </div>

          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <Kpi
              title={t('logs:kpiLines')}
              icon={<FileText />}
              value={logs.length.toLocaleString()}
              sub={t('logs:kpiLinesSub', { count: shown.length })}
              delay={40}
            />
            <Kpi
              title={t('logs:kpiErrors')}
              icon={<ShieldAlert />}
              value={stats.errors.toLocaleString()}
              sub={t('logs:kpiLastHour', { count: stats.recentErrors })}
              delay={80}
            />
            <Kpi
              title={t('logs:kpiWarnings')}
              icon={<AlertTriangle />}
              value={stats.warnings.toLocaleString()}
              sub={t('logs:kpiLastHour', { count: stats.recentWarnings })}
              delay={120}
            />
            <Kpi
              title={t('logs:kpiSources')}
              icon={<Layers />}
              value={stats.top.length}
              sub={
                stats.top[0]
                  ? t('logs:kpiSourcesSub', { name: stats.top[0][0] })
                  : t('logs:kpiSourcesNone')
              }
              delay={160}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Frame
              className="motion-safe:animate-rise-in"
              style={{ animationDelay: '200ms' }}
            >
              <FrameHeader
                icon={<BarChart3 />}
                title={t('logs:activity')}
                actions={
                  <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                    <i className="ml-1.5 size-2 rounded-[2px] bg-sk-2" />
                    {t('logs:levelInfo')}
                    <i className="ml-1.5 size-2 rounded-[2px] bg-warning" />
                    {t('logs:levelWarn')}
                    <i className="ml-1.5 size-2 rounded-[2px] bg-destructive" />
                    {t('logs:levelError')}
                  </span>
                }
              />
              <FrameBody className="p-3.5">
                <ActivityChart logs={logs} />
              </FrameBody>
            </Frame>
            <Frame
              className="motion-safe:animate-rise-in"
              style={{ animationDelay: '240ms' }}
            >
              <FrameHeader icon={<Waypoints />} title={t('logs:topSources')} />
              <FrameBody className="gap-0.5 p-2.5">
                {stats.top.length === 0 && (
                  <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                    {t('logs:kpiSourcesNone')}
                  </p>
                )}
                {stats.top.slice(0, 8).map(([name, n]) => {
                  const on = source === name
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={on}
                      title={t('logs:filterSource', { name })}
                      onClick={() => setSource(on ? null : name)}
                      className={cn(
                        'grid grid-cols-[88px_minmax(0,1fr)_34px] items-center gap-2.5 rounded-lg px-1 py-1.5 text-left transition-colors outline-hidden hover:bg-hover-row focus-visible:ring-[3px] focus-visible:ring-ring/40',
                        on && 'bg-hover-row'
                      )}
                    >
                      <SourceTag source={name} />
                      <span className="h-1.5 w-full overflow-hidden rounded-full bg-track">
                        <i
                          className="block h-full rounded-full motion-safe:animate-draw-x"
                          style={{
                            width: `${(n / topMax) * 100}%`,
                            background: sourceColour(name),
                          }}
                        />
                      </span>
                      <b className="text-right text-xs font-medium tabular-nums">
                        {n}
                      </b>
                    </button>
                  )
                })}
              </FrameBody>
            </Frame>
          </div>

          <Frame
            className="motion-safe:animate-rise-in"
            style={{ animationDelay: '280ms' }}
          >
            <FrameHeader
              icon={<SquareTerminal />}
              title={fileName}
              actions={
                <>
                  <Chip tone={follow ? 'ok' : 'neutral'} dot live={follow}>
                    {follow ? t('logs:following') : t('logs:paused')}
                  </Chip>
                  <Button
                    variant="outline"
                    size="xs"
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
            <FrameBody className="overflow-hidden">
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
                      className="inline-flex h-[22px] items-center gap-1.5 rounded-md border-[0.8px] border-border bg-card px-2 text-xs font-medium text-secondary-foreground hover:bg-hover-row"
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
                className="max-h-[62vh] min-h-[240px]"
                emptyText={
                  logs.length === 0 ? t('logs:noLogs') : t('logs:noMatch')
                }
              />
            </FrameBody>
          </Frame>
        </div>
      </div>
    </div>
  )
}
