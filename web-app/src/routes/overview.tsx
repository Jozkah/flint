import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Calendar,
  CheckCircle2,
  ChevronDown,
  Gauge,
  Layers,
  Loader2,
  MoreVertical,
  Newspaper,
  Search,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Target,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { EmptyState } from '@/components/ui/empty-state'
import { CountUp } from '@/components/ui/count-up'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  change,
  summarize,
  useUsageStats,
  type ActivityItem,
  type ActivityKind,
  type RangeSummary,
} from '@/stores/usage-stats-store'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'

export const Route = createFileRoute('/overview')({
  component: Overview,
})

type Range = 7 | 30

const compact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
      : String(Math.round(n))

const pct = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`

function greetingKey(now: Date) {
  const h = now.getHours()
  if (h < 12) return 'overview:morning'
  if (h < 18) return 'overview:afternoon'
  return 'overview:evening'
}

/** A small line chart of a daily series, scaled to its own maximum. */
function Sparkline({ values, tone }: { values: number[]; tone: 'up' | 'down' }) {
  const w = 91
  const h = 36
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 6)).toFixed(1)}`)
  const color = tone === 'up' ? 'var(--success)' : 'var(--destructive)'
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-9 w-[91px] shrink-0 origin-bottom-right transition-transform duration-300 group-hover/kpi:scale-105"
      aria-hidden
    >
      <defs>
        <linearGradient id={`spark-${tone}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.25" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill={`url(#spark-${tone})`} />
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        className="motion-safe:animate-draw-x"
      />
    </svg>
  )
}

function Kpi({
  title,
  icon: Icon,
  value,
  delta,
  series,
  cmpLabel,
  delay,
}: {
  title: string
  icon: LucideIcon
  value: string
  delta: number | null
  series: number[]
  cmpLabel: string
  delay: number
}) {
  return (
    <Frame
      className="group/kpi h-[140px] min-w-0 motion-safe:animate-rise-in"
      style={{ animationDelay: `${delay}ms` }}
    >
      <FrameHeader
        title={title}
        actions={
          <Icon className="size-4 text-muted-foreground transition-transform duration-300 ease-expo group-hover/kpi:-rotate-12 group-hover/kpi:scale-110" aria-hidden />
        }
      />
      <FrameBody className="flex-row items-end justify-between rounded-[10px] border-border px-3 pb-3 transition-[box-shadow,transform] duration-300 ease-expo group-hover/kpi:-translate-y-px group-hover/kpi:shadow-lift">
        <div className="flex flex-col gap-2">
          <p className="text-2xl leading-none font-medium tabular-nums">
            <CountUp value={value} delayMs={delay + 150} />
          </p>
          <p className="flex items-center gap-1.5 text-xs leading-none">
            {delta === null ? (
              <span className="text-muted-foreground">{cmpLabel}</span>
            ) : (
              <>
                <span className={cn('font-medium tabular-nums', delta >= 0 ? 'text-success' : 'text-destructive')}>
                  {pct(delta)}
                </span>
                <span className="text-muted-foreground">{cmpLabel}</span>
              </>
            )}
          </p>
        </div>
        <Sparkline values={series} tone={delta !== null && delta < 0 ? 'down' : 'up'} />
      </FrameBody>
    </Frame>
  )
}

/** Tokens per day as bars, with the inspected day raised in the accent. */
function Throughput({
  summary,
  previous,
  cmpLabel,
}: {
  summary: RangeSummary
  previous: RangeSummary
  cmpLabel: string
}) {
  const { t, i18n } = useTranslation()
  const values = summary.series.map((d) => d.stats.tokens)
  const rawMax = Math.max(...values, 1)
  // Round the axis up to a readable step so every label is a value the bars
  // can reach.
  const magnitude = 10 ** Math.floor(Math.log10(rawMax))
  const top = Math.ceil(rawMax / magnitude) * magnitude
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => top * f)
  const today = values.length - 1
  const [hover, setHover] = useState<number | null>(null)
  const active = hover ?? today
  const delta = change(summary.tokens, previous.tokens)
  const showLabel = (i: number) => values.length <= 7 || i % 5 === 0 || i === values.length - 1
  const dayLabel = (d: Date) =>
    values.length <= 7
      ? d.toLocaleDateString(i18n.language, { weekday: 'short' })
      : d.toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })
  const activeH = (values[active] / top) * 100

  return (
    <Frame className="min-w-0 motion-safe:animate-rise-in" style={{ animationDelay: '260ms' }}>
      <FrameHeader icon={<BarChart3 />} title={t('overview:throughput')} />
      <FrameBody className="gap-6 px-3.5 pt-4 pb-3.5">
        <div className="flex items-end gap-3 leading-none whitespace-nowrap">
          <p className="text-[32px] font-medium tabular-nums">
            <CountUp value={summary.tokens.toLocaleString('en-US')} delayMs={400} />
          </p>
          <p className="flex items-center gap-1.5 text-xs">
            {delta !== null && (
              <span className={cn('font-medium', delta >= 0 ? 'text-success' : 'text-destructive')}>{pct(delta)}</span>
            )}
            <span className="text-muted-foreground">{cmpLabel}</span>
          </p>
        </div>
        <div className="flex w-full items-stretch gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div
              className="relative h-[216px] w-full rounded-xs outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40"
              role="group"
              tabIndex={0}
              aria-label={t('overview:throughputAria')}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') setHover(Math.max(0, active - 1))
                if (e.key === 'ArrowRight') setHover(Math.min(values.length - 1, active + 1))
              }}
              onMouseLeave={() => setHover(null)}
            >
              {ticks.slice(0, 4).map((v) => (
                <div
                  key={v}
                  aria-hidden
                  className="absolute inset-x-0 border-t border-dashed border-border/70"
                  style={{ bottom: `${(v / top) * 100}%` }}
                />
              ))}
              <div className="absolute inset-0 flex items-end gap-1.5">
                {values.map((v, i) => (
                  <div
                    key={summary.series[i].key}
                    className="relative flex h-full min-w-0 flex-1 items-end"
                    onMouseEnter={() => setHover(i)}
                  >
                    <div
                      className={cn(
                        'relative w-full origin-bottom rounded-t-lg rounded-b-sm transition-[height] duration-700 ease-expo motion-safe:animate-grow-y',
                        i === active
                          ? 'bg-grad shadow-[inset_0_0_0_.44px_var(--primary),0_2px_10px_rgba(31,41,55,.08)]'
                          : 'bg-[linear-gradient(to_bottom,var(--bar),var(--bar-2))] shadow-[inset_0_0_0_.444px_var(--bar-border),inset_0_0_0_1px_var(--bar-inner)]'
                      )}
                      style={{ height: `${Math.max((v / top) * 100, v > 0 ? 2 : 0.8)}%`, animationDelay: `${i * 25}ms` }}
                    />
                  </div>
                ))}
              </div>
              {/* The inspected value: a dashed rule at its height and a tag. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 border-t border-dashed border-foreground/40 transition-[bottom] duration-500 ease-expo"
                style={{ bottom: `${activeH}%` }}
              />
              <div
                className="pointer-events-none absolute z-10 -translate-y-1/2 rounded-md bg-primary px-2 py-1 text-xs leading-none font-medium whitespace-nowrap text-on-grad shadow-pop transition-[left,bottom] duration-500 ease-expo"
                style={{
                  bottom: `${activeH}%`,
                  left: `calc(${((active + 0.5) / values.length) * 100}% ${active > values.length / 2 ? '- 5.5rem' : '+ 0.75rem'})`,
                }}
                role="status"
              >
                {dayLabel(summary.series[active].date)} : {compact(values[active])}
              </div>
            </div>
            <div className="flex w-full gap-1.5" aria-hidden>
              {summary.series.map((d, i) => (
                <div key={d.key} className="flex min-w-0 flex-1 justify-center">
                  {showLabel(i) && (
                    <p className={cn('text-xs leading-none whitespace-nowrap transition-colors', i === active ? 'text-foreground' : 'text-muted-foreground')}>
                      {dayLabel(d.date)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="flex h-[220px] flex-col items-end justify-between" aria-hidden>
            {ticks.map((v) => (
              <p key={v} className="text-xs leading-none text-muted-foreground tabular-nums">
                {compact(v)}
              </p>
            ))}
          </div>
        </div>
      </FrameBody>
    </Frame>
  )
}

const ACTIVITY_ICON: Record<ActivityKind, { icon: LucideIcon; tone: string }> = {
  'tool-approved': { icon: ShieldCheck, tone: 'text-info' },
  'tool-denied': { icon: ShieldX, tone: 'text-warning' },
  'tool-failed': { icon: AlertTriangle, tone: 'text-destructive' },
  'model-loaded': { icon: Zap, tone: 'text-success' },
  'model-swapped': { icon: Sparkles, tone: 'text-merged' },
  compaction: { icon: Layers, tone: 'text-warning' },
  'run-finished': { icon: CheckCircle2, tone: 'text-success' },
  knowledge: { icon: Newspaper, tone: 'text-info' },
  warning: { icon: AlertTriangle, tone: 'text-destructive' },
}

type FeedRange = 'today' | 'yesterday' | 'week'

function LatestActivity({ items }: { items: ActivityItem[] }) {
  const { t, i18n } = useTranslation()
  const [range, setRange] = useState<FeedRange>('today')
  const [q, setQ] = useState('')
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const inRange = (at: number) =>
    range === 'today'
      ? at >= startToday
      : range === 'yesterday'
        ? at >= startToday - 86_400_000 && at < startToday
        : at >= startToday - 6 * 86_400_000
  const list = items.filter(
    (it) =>
      inRange(it.at) &&
      (!q || `${it.title} ${it.detail ?? ''}`.toLowerCase().includes(q.toLowerCase()))
  )
  return (
    <Frame className="h-full min-h-[420px] w-full motion-safe:animate-rise-in lg:w-[300px] lg:shrink-0" style={{ animationDelay: '200ms' }}>
      <FrameHeader title={t('overview:activity')} actions={<Newspaper className="size-4 text-muted-foreground" aria-hidden />} />
      <FrameBody className="min-h-0 gap-4 overflow-hidden px-3.5 pt-4 pb-3.5">
        <Segmented
          aria-label={t('overview:activityRange')}
          value={range}
          onValueChange={setRange}
          options={[
            { value: 'today', label: t('overview:today') },
            { value: 'yesterday', label: t('overview:yesterday') },
            { value: 'week', label: t('overview:thisWeek') },
          ]}
        />
        <label className="flex h-8 w-full cursor-text items-center gap-2 rounded-lg border-[0.8px] border-border bg-card px-2.5 transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20 hover:border-border-strong">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('overview:searchActivity')}
            aria-label={t('overview:searchActivity')}
            className="min-w-0 flex-1 bg-transparent text-[0.8125rem] outline-hidden placeholder:text-muted-foreground"
          />
        </label>
        <p className="m-0 text-[0.8125rem] text-muted-foreground">
          <b className="font-medium text-foreground tabular-nums">{list.length}</b>{' '}
          {t(`overview:newActivities.${range}`, { count: list.length })}
        </p>
        <div aria-hidden className="h-px w-full bg-[linear-gradient(90deg,transparent,var(--border)_15%,var(--border)_85%,transparent)]" />
        {list.length === 0 ? (
          <EmptyState icon={<Activity />} title={t('overview:noActivity')} description={t('overview:noActivityHint')} />
        ) : (
          <ul className="m-0 flex min-h-0 w-full flex-1 list-none flex-col gap-5 overflow-y-auto p-0 pb-1 [scrollbar-width:none]">
            {list.map((it, i) => {
              const { icon: Icon, tone } = ACTIVITY_ICON[it.kind] ?? ACTIVITY_ICON.warning
              return (
                <li
                  key={it.id}
                  className="group/item relative flex w-full items-start gap-3 motion-safe:animate-rise-in"
                  style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                >
                  <span className="relative z-10 flex items-center rounded-lg border-[0.8px] border-input bg-card p-2 transition-[transform,box-shadow] duration-200 ease-expo group-hover/item:-translate-y-px group-hover/item:shadow-lift">
                    <Icon className={cn('size-4 transition-transform duration-300 group-hover/item:scale-110', tone)} aria-hidden />
                  </span>
                  {i < list.length - 1 && (
                    <span aria-hidden className="absolute top-8 -bottom-5 left-[15.5px] w-px bg-[repeating-linear-gradient(to_bottom,var(--border)_0_4px,transparent_4px_8px)]" />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-0.5 text-xs tracking-[-.01em]">
                    <div className="flex w-full items-center justify-between gap-2 leading-none">
                      <p className="m-0 truncate font-medium">{it.title}</p>
                      <time className="shrink-0 text-subtle-foreground" dateTime={new Date(it.at).toISOString()}>
                        {new Date(it.at).toLocaleTimeString(i18n.language, { hour: 'numeric', minute: '2-digit' })}
                      </time>
                    </div>
                    {it.detail && <p className="m-0 truncate leading-none text-subtle-foreground">{it.detail}</p>}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </FrameBody>
    </Frame>
  )
}

type RunRow = {
  id: string
  index: number
  title: string
  model: string
  status: 'running' | 'approval' | 'done' | 'idle'
  started: number | null
  tokens: number
}

function runsFrom(sessions: CoworkSession[], running: Record<string, unknown>): RunRow[] {
  return sessions.map((s, i) => {
    const started = s.turns.find((tu) => tu.startedAt)?.startedAt ?? null
    const tokens = s.turns.reduce((n, tu) => n + (tu.usage?.completion_tokens ?? tu.tokenSpeed?.tokenCount ?? 0), 0)
    const asksOpen = s.turns.some((tu) => (tu.asks ?? []).some((a) => !(a as { answer?: unknown }).answer))
    return {
      id: s.id,
      index: i,
      title: s.title,
      model: s.model?.id ?? '—',
      status: running[s.id] ? 'running' : asksOpen ? 'approval' : s.turns.length ? 'done' : 'idle',
      started,
      tokens,
    }
  })
}

const STATUS: Record<RunRow['status'], { icon: LucideIcon; cls: string; key: string }> = {
  running: { icon: Loader2, cls: 'text-warning [&>svg]:motion-safe:animate-spin', key: 'overview:status.running' },
  approval: { icon: ShieldCheck, cls: 'text-info', key: 'overview:status.approval' },
  done: { icon: CheckCircle2, cls: 'text-success', key: 'overview:status.done' },
  idle: { icon: Target, cls: 'text-muted-foreground', key: 'overview:status.idle' },
}

function AgentRuns() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const sessions = useCoworkSessions((s) => s.sessions)
  const runs = useCoworkRun((s) => s.runs)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | RunRow['status']>('all')
  const rows = useMemo(() => runsFrom(sessions, runs), [sessions, runs])
  const visible = rows.filter(
    (r) =>
      (filter === 'all' || r.status === filter) &&
      (!q || `${r.title} ${r.model}`.toLowerCase().includes(q.toLowerCase()))
  )
  const open = (id: string) => {
    useCoworkSessions.getState().selectSession(id)
    navigate({ to: route.cowork })
  }
  return (
    <Frame className="motion-safe:animate-rise-in" style={{ animationDelay: '340ms' }}>
      <FrameHeader
        icon={<Target />}
        title={t('overview:runs')}
        actions={
          <>
            <label className="hidden h-8 w-56 cursor-text items-center gap-2 rounded-lg border-[0.8px] border-input bg-card px-2.5 shadow-[0_4px_14px_rgba(0,0,0,.04)] focus-within:border-ring sm:flex">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('overview:searchRuns')}
                aria-label={t('overview:searchRuns')}
                className="min-w-0 flex-1 bg-transparent text-[0.8125rem] outline-hidden placeholder:text-muted-foreground"
              />
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="surface">
                  <Wrench />
                  {t('overview:filter')}
                  {filter !== 'all' && (
                    <span className="-mr-1 ml-0.5 grid size-4 place-items-center rounded-full bg-primary text-[10px] text-on-grad">1</span>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuRadioGroup value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
                  <DropdownMenuRadioItem value="all">{t('overview:filterAll')}</DropdownMenuRadioItem>
                  {(['running', 'approval', 'done', 'idle'] as const).map((s) => (
                    <DropdownMenuRadioItem key={s} value={s}>{t(STATUS[s].key)}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <div className="w-full overflow-x-auto rounded-xl bg-card p-1.5 shadow-[inset_0_0_0_.8px_var(--input)] [scrollbar-width:thin]">
        {rows.length === 0 ? (
          <EmptyState
            icon={<Target />}
            title={t('overview:noRuns')}
            description={t('overview:noRunsHint')}
            action={<Button variant="outline" onClick={() => navigate({ to: route.cowork })}>{t('overview:openCowork')}</Button>}
          />
        ) : (
          <table className="w-full min-w-[720px] border-separate border-spacing-0 text-[0.8125rem]" aria-label={t('overview:runs')}>
            <thead>
              <tr className="text-left text-secondary-foreground">
                {['run', 'task', 'model', 'status', 'started', 'tokens'].map((c, i, a) => (
                  <th
                    key={c}
                    scope="col"
                    className={cn(
                      'h-9 bg-secondary px-3 font-normal whitespace-nowrap',
                      i === 0 && 'rounded-l-lg',
                      i === a.length - 1 && 'rounded-r-lg text-right'
                    )}
                  >
                    {t(`overview:col.${c}`)}
                  </th>
                ))}
                <th className="h-9 w-10 rounded-r-lg bg-secondary" />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const S = STATUS[r.status]
                return (
                  <tr
                    key={r.id}
                    className="group/row h-[45px] cursor-pointer transition-colors hover:bg-hover-row"
                    onClick={() => open(r.id)}
                  >
                    <td className="border-b border-border/60 px-3 font-medium text-cell tabular-nums">#{1000 + r.index + 1}</td>
                    <td className="max-w-0 truncate border-b border-border/60 px-3 font-medium text-cell group-hover/row:text-foreground">{r.title}</td>
                    <td className="truncate border-b border-border/60 px-3 text-cell">{r.model}</td>
                    <td className="border-b border-border/60 px-3">
                      <span className={cn('inline-flex items-center gap-1.5 font-medium whitespace-nowrap [&>svg]:size-3.5', S.cls)}>
                        <S.icon aria-hidden />
                        <span className="text-cell">{t(S.key)}</span>
                      </span>
                    </td>
                    <td className="border-b border-border/60 px-3 text-cell tabular-nums whitespace-nowrap">
                      {r.started ? new Date(r.started).toLocaleDateString(i18n.language) : '—'}
                    </td>
                    <td className="border-b border-border/60 px-3 text-right text-cell tabular-nums">{r.tokens ? compact(r.tokens) : '—'}</td>
                    <td className="border-b border-border/60 px-1 text-right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('overview:openRun')}
                        onClick={(e) => {
                          e.stopPropagation()
                          open(r.id)
                        }}
                      >
                        <MoreVertical />
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </Frame>
  )
}

/**
 * The start page: what the models on this computer did over the last week or
 * month, what happened recently, and the Cowork runs. Every figure is counted
 * locally as it happens (stores/usage-stats-store); nothing is estimated.
 */
function Overview() {
  const { t } = useTranslation()
  const days = useUsageStats((s) => s.days)
  const activity = useUsageStats((s) => s.activity)
  const [range, setRange] = useState<Range>(7)
  const now = Date.now()
  const current = useMemo(() => summarize(days, range, now), [days, range, now])
  const previous = useMemo(() => summarize(days, range, now - range * 86_400_000), [days, range, now])
  const cmpLabel = range === 7 ? t('overview:vsLastWeek') : t('overview:vsLastMonth')
  const rangeLabel = range === 7 ? t('overview:lastWeek') : t('overview:last30')

  return (
    <div className="h-full overflow-x-hidden overflow-y-auto px-1 pt-2 pb-6 [scrollbar-width:thin]" data-testid="overview-page">
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-4 leading-none motion-safe:animate-rise-in">
            <h1 className="m-0 text-2xl font-medium tracking-[-.01em]">
              {t(greetingKey(new Date(now)))}
              <span aria-hidden className="ml-2 inline-block origin-[70%_70%] motion-safe:animate-[wave_1.8s_ease-in-out_.6s_1]">👋</span>
            </h1>
            <p className="m-0 text-[0.8125rem] text-secondary-foreground">
              {range === 7 ? t('overview:subWeek') : t('overview:subMonth')}
            </p>
          </div>
          <div className="flex items-center gap-2 motion-safe:animate-rise-in" style={{ animationDelay: '60ms' }}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="group/range w-[128px] justify-between">
                  <span className="flex items-center gap-1.5">
                    <Calendar aria-hidden />
                    {rangeLabel}
                  </span>
                  <ChevronDown className="size-3 transition-transform duration-200 group-data-[state=open]/range:rotate-180" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuRadioGroup value={String(range)} onValueChange={(v) => setRange(Number(v) as Range)}>
                  <DropdownMenuRadioItem value="7">{t('overview:lastWeek')}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="30">{t('overview:last30')}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t('overview:options')}>
                  <MoreVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem variant="destructive" onSelect={() => useUsageStats.getState().reset()}>
                  <Gauge />
                  <span>{t('overview:resetStats')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-3">
              <Kpi
                title={t('overview:tokens')}
                icon={BarChart3}
                value={compact(current.tokens)}
                delta={change(current.tokens, previous.tokens)}
                series={current.series.map((d) => d.stats.tokens)}
                cmpLabel={cmpLabel}
                delay={80}
              />
              <Kpi
                title={t('overview:speed')}
                icon={Zap}
                value={current.speed === null ? '—' : `${current.speed.toFixed(1)} tok/s`}
                delta={change(current.speed, previous.speed)}
                series={current.series.map((d) =>
                  d.stats.genMs > 0 ? d.stats.timedTokens / (d.stats.genMs / 1000) : 0
                )}
                cmpLabel={cmpLabel}
                delay={140}
              />
              <Kpi
                title={t('overview:toolSuccess')}
                icon={Gauge}
                value={current.toolSuccess === null ? '—' : `${(current.toolSuccess * 100).toFixed(1)}%`}
                delta={change(current.toolSuccess, previous.toolSuccess)}
                series={current.series.map((d) => {
                  const n = d.stats.toolOk + d.stats.toolFail
                  return n ? d.stats.toolOk / n : 0
                })}
                cmpLabel={cmpLabel}
                delay={200}
              />
            </div>
            <Throughput summary={current} previous={previous} cmpLabel={cmpLabel} />
          </div>
          <LatestActivity items={activity} />
        </div>

        <AgentRuns />
      </div>
    </div>
  )
}
