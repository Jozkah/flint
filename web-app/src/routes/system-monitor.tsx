/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from '@tanstack/react-router'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { ChevronRight, Info } from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { Switch } from '@/components/ui/switch'
import { useHardware, type GPU } from '@/hooks/useHardware'
import { useLlamacppDevices } from '@/hooks/useLlamacppDevices'
import { useAppState } from '@/hooks/useAppState'
import { route } from '@/constants/routes'
import { cn, formatMegaBytes } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { toNumber } from '@/utils/number'
import { useServiceHub } from '@/hooks/useServiceHub'
import { SystemPageHeader } from '@/containers/SystemPageHeader'
import { useHeaderSlot } from '@/components/shell/HeaderSlot'
import { Chip } from '@/components/ui/chip'
import {
  backendLabel,
  groupDevices,
  groupForGpu,
  parseDeviceId,
  selectedDevice,
  type GpuGroup,
} from '@/lib/gpuDevices'
import {
  computeNetworkRates,
  diskUsedPercent,
  formatBytes,
  formatFrequency,
  formatRate,
  formatTemperature,
  formatUptime,
  interfaceKind,
  isVirtualInterface,
  type NetworkRate,
  type SystemSnapshot,
} from '@/lib/systemMonitor'

export const Route = createFileRoute(route.systemMonitor as any)({
  component: SystemMonitorContent,
})

/** Poll interval, matching the page's "updates every 5 seconds". */
const POLL_MS = 5000

/** Samples kept per chart: two minutes at the 5 second poll. */
const HISTORY = 24

const pageHidden = () =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden'

function gpuBackendLabel(gpu: GPU): string {
  if (gpu.nvidia_info?.compute_capability) return 'CUDA'
  if (gpu.vulkan_info?.api_version) return 'Vulkan'
  return gpu.vendor || 'GPU'
}

const clampPercent = (percent: number) =>
  Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0))

/** The colour each card plots and badges itself with. */
const ACCENT = {
  cpu: '#4f8cff',
  memory: '#a76bff',
  gpu: '#4f8cff',
  down: '#ff5d6c',
  up: '#a76bff',
}

/**
 * Load bands. The fill stays the neutral gradient until usage is high enough
 * to matter; only then does it turn amber, then red.
 */
function band(percent: number): 'ok' | 'warn' | 'err' {
  if (percent >= 90) return 'err'
  if (percent >= 75) return 'warn'
  return 'ok'
}

const BAND_FILL = {
  ok: 'bg-grad',
  warn: 'bg-[linear-gradient(90deg,var(--warning),color-mix(in_oklab,var(--warning),#000_14%))]',
  err: 'bg-[linear-gradient(90deg,var(--destructive),color-mix(in_oklab,var(--destructive),#000_14%))]',
}

/** A labelled usage bar with its measured number beside it. */
function Meter({
  label,
  percent,
  display,
  color,
  className,
}: {
  label: string
  percent: number
  /** Shown instead of the percent, e.g. a rate or a temperature. */
  display?: string
  /** A fixed fill colour instead of the load bands. */
  color?: string
  className?: string
}) {
  const clamped = clampPercent(percent)
  return (
    <div className={cn('mt-3 flex flex-col gap-2', className)}>
      <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className="text-muted-foreground">{label}</span>
        <b className="font-medium tabular-nums text-foreground">
          {display ?? `${percent.toFixed(2)}%`}
        </b>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
        className="h-1.5 w-full overflow-hidden rounded-full bg-track"
      >
        <div
          className={cn(
            'h-full rounded-full motion-safe:animate-draw-x motion-safe:transition-[width] motion-safe:duration-600 motion-safe:ease-expo',
            !color && BAND_FILL[band(clamped)]
          )}
          style={{ width: `${clamped}%`, ...(color ? { background: color } : null) }}
        />
      </div>
    </div>
  )
}

/** The "dot, label, value" line above a chart. */
function UsageLine({
  label,
  percent,
  color,
}: {
  label: string
  percent: number
  color: string
}) {
  return (
    <div className="mt-4 flex items-center justify-between gap-2 text-[13px]">
      <span className="flex items-center gap-2 text-secondary-foreground">
        <span className="size-2.5 rounded-full" style={{ background: color }} aria-hidden />
        {label}
      </span>
      <b className="font-semibold tabular-nums text-foreground">{percent.toFixed(2)}%</b>
    </div>
  )
}

/**
 * Recent samples as a filled line on a 0 / 50 / 100 % grid. Drawn to the
 * card's width; the stroke keeps its weight however wide that is.
 */
function AreaChart({ values, color }: { values: number[]; color: string }) {
  const id = useId()
  const n = values.length
  const pts =
    n < 2
      ? []
      : values.map(
          (v, i) => `${((i / (n - 1)) * 120).toFixed(1)},${(60 - (clampPercent(v) / 100) * 60).toFixed(1)}`
        )
  return (
    <div className="mt-2 flex items-stretch gap-2" aria-hidden>
      <div className="relative h-[84px] min-w-0 flex-1 overflow-hidden rounded-sm border border-border/70 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px)] bg-[length:12.5%_100%] [background-position:-1px_0]">
        <div className="absolute inset-x-0 top-1/2 border-t border-border/70" />
        {pts.length > 0 && (
          <svg viewBox="0 0 120 60" preserveAspectRatio="none" className="absolute inset-0 size-full">
            <defs>
              <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style={{ stopColor: color, stopOpacity: 0.5 }} />
                <stop offset="1" style={{ stopColor: color, stopOpacity: 0.02 }} />
              </linearGradient>
            </defs>
            <path d={`M0,60L${pts.join('L')}L120,60Z`} fill={`url(#${id})`} />
            <path
              d={`M${pts.join('L')}`}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
      </div>
      <div className="flex w-9 shrink-0 flex-col justify-between py-0.5 text-[11px] text-muted-foreground tabular-nums">
        <span>100%</span>
        <span>50%</span>
        <span>0%</span>
      </div>
    </div>
  )
}

/** Label/value pairs in the design's two-column key table. */
function Stats({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-[13px]">
      {children}
    </dl>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground tabular-nums">{children}</dd>
    </>
  )
}

/** An icon on a soft tinted tile, as the design draws each card's mark. */
function IconTile({ children, size = 'md' }: { children: ReactNode; size?: 'md' | 'lg' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center border-[0.8px] border-blue-400/25 bg-[linear-gradient(145deg,rgb(79_140_255/0.22),rgb(79_140_255/0.06))] text-blue-300',
        size === 'lg' ? 'size-11 rounded-2xl' : 'size-9 rounded-xl'
      )}
    >
      {children}
    </span>
  )
}

/** The pill in a card's corner: a dot and the current figure. */
function Badge({
  color,
  percent,
  label,
  children,
}: {
  color: string
  percent: number
  label: string
  children: ReactNode
}) {
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clampPercent(percent))}
      className="inline-flex h-7 items-center gap-1.5 rounded-lg border-[0.8px] px-2.5 text-xs font-medium tabular-nums text-foreground"
      style={{
        borderColor: `${color}66`,
        background: `${color}1f`,
      }}
    >
      <span className="size-1.5 rounded-full" style={{ background: color }} aria-hidden />
      {children}
    </span>
  )
}

function Panel({
  title,
  icon,
  delay,
  badge,
  actions,
  className,
  children,
}: {
  title: string
  icon: ReactNode
  delay: number
  badge?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col rounded-2xl border-[0.8px] border-border bg-card p-4 motion-safe:animate-rise-in',
        className
      )}
      style={{ animationDelay: `${delay}ms` } as CSSProperties}
    >
      <header className="mb-4 flex min-w-0 items-center justify-between gap-3">
        <h3 className="flex min-w-0 items-center gap-3 text-[17px] font-medium text-foreground">
          <IconTile>{icon}</IconTile>
          <span className="truncate">{title}</span>
        </h3>
        {badge ?? actions}
      </header>
      {children}
    </section>
  )
}

/** Appends a sample, keeping the last {@link HISTORY}. */
const pushSample = (list: number[] | undefined, value: number) =>
  [...(list ?? [value]), value].slice(-HISTORY)

/** A rate as a share of the highest rate seen on that interface. */
function ratePercent(rate: number | undefined, peak: number | undefined) {
  if (!rate || !peak) return 0
  return (rate / peak) * 100
}

/**
 * How full a sensor's meter is: against its critical point, else its
 * recorded max, else 100 °C. Warm (75%) and hot (90%) use the load bands.
 */
function temperatureScale(sensor: SystemSnapshot['sensors'][number]) {
  const temp = sensor.temperature ?? 0
  const pick = (
    limit: number | null,
    of: 'ofCritical' | 'ofMax'
  ): { limit: number; of: 'ofCritical' | 'ofMax' } | null =>
    limit != null && limit > temp && limit > 0 ? { limit, of } : null
  const chosen = pick(sensor.critical, 'ofCritical') ?? pick(sensor.max, 'ofMax')
  if (!chosen) return { limit: null, of: null, percent: temp }
  return { ...chosen, percent: (temp / chosen.limit) * 100 }
}

/** Per-core usage, folded away until asked for. */
function PerCoreUsage({ values }: { values: number[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="mt-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-xl border-[0.8px] border-border bg-muted/40 px-3.5 text-[13px] text-secondary-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden"
      >
        <span>{t('system-monitor:perCore')}</span>
        <ChevronRight
          aria-hidden
          className={cn('size-4 text-muted-foreground transition-transform duration-200', open && 'rotate-90')}
        />
      </button>
      {open && (
        <div
          id={id}
          className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1.5"
        >
          {values.map((v, i) => {
            const clamped = clampPercent(v)
            return (
              <div
                key={i}
                role="meter"
                aria-label={t('system-monitor:coreN', { n: i })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(clamped)}
                className="flex flex-col gap-1 rounded-md bg-muted px-2 py-1.5"
              >
                <div className="flex items-baseline justify-between text-[11px] tabular-nums">
                  <span className="text-muted-foreground">#{i}</span>
                  <b className="font-medium text-foreground">{Math.round(clamped)}%</b>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-track">
                  <div
                    className={cn('h-full rounded-full', BAND_FILL[band(clamped)])}
                    style={{ width: `${clamped}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** A muted note for data the platform does not expose. */
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl bg-muted px-3.5 py-3 text-[13px] text-muted-foreground">
      {children}
    </div>
  )
}

/** A computer drawn in two tones, standing in for a photo of this machine. */
function MachineArt() {
  return (
    <div
      aria-hidden
      className="grid h-[132px] w-[124px] shrink-0 place-items-center rounded-xl border-[0.8px] border-border bg-[radial-gradient(circle_at_50%_40%,rgb(79_140_255/0.18),transparent_70%)]"
    >
      <svg viewBox="0 0 96 88" className="h-20 w-24">
        <rect x="6" y="6" width="62" height="46" rx="4" fill="#0f1b33" stroke="#4f8cff" strokeOpacity="0.7" />
        <rect x="11" y="11" width="52" height="36" rx="2" fill="#12306a" />
        {IS_WINDOWS ? (
          <g fill="#7fb2ff">
            <rect x="26" y="19" width="10" height="9" />
            <rect x="38" y="19" width="10" height="9" />
            <rect x="26" y="30" width="10" height="9" />
            <rect x="38" y="30" width="10" height="9" />
          </g>
        ) : (
          <circle cx="37" cy="29" r="9" fill="#7fb2ff" />
        )}
        <rect x="30" y="52" width="14" height="6" fill="#1b2a4a" />
        <rect x="22" y="58" width="30" height="4" rx="2" fill="#1b2a4a" />
        <rect x="68" y="22" width="22" height="48" rx="3" fill="#0f1b33" stroke="#4f8cff" strokeOpacity="0.5" />
        <circle cx="79" cy="32" r="3" fill="#4f8cff" />
        <rect x="72" y="42" width="14" height="2" rx="1" fill="#1b2a4a" />
        <rect x="72" y="48" width="14" height="2" rx="1" fill="#1b2a4a" />
      </svg>
    </div>
  )
}

function SystemPanel({
  snapshot,
  cpuName,
  arch,
  totalMemory,
  gpuNames,
}: {
  snapshot: SystemSnapshot
  cpuName: string
  arch: string
  totalMemory: number
  gpuNames: string[]
}) {
  const { t } = useTranslation()
  return (
    <Panel
      title={t('system-monitor:system')}
      icon={<Info className="size-4" />}
      delay={240}
      className="xl:col-span-5"
    >
      <div className="flex min-w-0 items-start gap-4">
        <MachineArt />
        <div className="min-w-0 flex-1 pt-1">
          <Stats>
            {snapshot.host_name && (
              <Stat label={t('system-monitor:hostName')}>
                <span className="font-mono">{snapshot.host_name}</span>
              </Stat>
            )}
            {snapshot.os_version && (
              <Stat label={t('system-monitor:osVersion')}>{snapshot.os_version}</Stat>
            )}
            {snapshot.kernel_version && (
              <Stat label={t('system-monitor:kernel')}>
                <span className="font-mono">{snapshot.kernel_version}</span>
              </Stat>
            )}
            <Stat label={t('system-monitor:uptime')}>{formatUptime(snapshot.uptime_secs)}</Stat>
          </Stats>
        </div>
      </div>
      {/* What this machine is made of, so the card is never a picture and a few lines. */}
      <div className="mt-5 border-t border-dashed border-border pt-4">
        <Stats>
          <Stat label={t('system-monitor:processor')}>{cpuName}</Stat>
          <Stat label={t('system-monitor:cores')}>
            {snapshot.cpu.physical_cores ?? '—'} / {snapshot.cpu.logical_cores}{' '}
            <span className="text-muted-foreground">{t('system-monitor:threads').toLowerCase()}</span>
          </Stat>
          <Stat label={t('system-monitor:architecture')}>
            <span className="font-mono">{arch}</span>
          </Stat>
          <Stat label={t('system-monitor:totalRam')}>{formatMegaBytes(totalMemory)}</Stat>
          {gpuNames.map((name, i) => (
            <Stat key={`${name}-${i}`} label={i === 0 ? t('system-monitor:graphics') : ''}>
              {name}
            </Stat>
          ))}
          <Stat label={t('system-monitor:drives')}>{snapshot.disks.length}</Stat>
        </Stats>
      </div>
    </Panel>
  )
}

function DrivesPanel({ snapshot }: { snapshot: SystemSnapshot }) {
  const { t } = useTranslation()
  return (
    <Panel
      title={t('system-monitor:drives')}
      icon={<Icon name="x-server" size={16} />}
      delay={300}
      className="md:col-span-2 xl:col-span-7"
    >
      {snapshot.disks.length === 0 ? (
        <Empty>{t('system-monitor:noDrives')}</Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {snapshot.disks.map((disk) => {
            const used = disk.total - Math.min(disk.available, disk.total)
            const percent = diskUsedPercent(disk)
            return (
              <div
                key={disk.mount_point}
                data-testid="drive-card"
                className="flex min-w-0 items-start gap-3.5 rounded-xl border-[0.8px] border-border bg-muted/30 p-3.5"
              >
                <span
                  aria-hidden
                  className="grid size-12 shrink-0 place-items-center rounded-xl border-[0.8px] border-border bg-card text-secondary-foreground"
                >
                  <Icon name="x-disk" size={22} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <b className="shrink-0 font-mono text-[14px] font-semibold text-foreground">
                        {disk.mount_point}
                      </b>
                      {disk.name && (
                        <span className="min-w-0 truncate text-xs text-muted-foreground" title={disk.name}>
                          {disk.name}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 gap-1.5">
                      {disk.file_system && <Chip mono>{disk.file_system}</Chip>}
                      {disk.kind !== 'Unknown' && <Chip mono>{disk.kind}</Chip>}
                      {disk.removable && (
                        <Chip tone="info" dot>
                          {t('system-monitor:removable')}
                        </Chip>
                      )}
                    </span>
                  </div>
                  <Meter
                    label={`${formatBytes(used)} / ${formatBytes(disk.total)}`}
                    percent={percent}
                    color="#4f8cff"
                    className="mt-2"
                  />
                  <div className="mt-1.5 text-[12px] text-muted-foreground tabular-nums">
                    {t('system-monitor:freeOf', { free: formatBytes(disk.available) })}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}

function NetworkPanel({
  snapshot,
  rates,
  peaks,
}: {
  snapshot: SystemSnapshot
  rates: Record<string, NetworkRate>
  /** Highest rate seen per interface this session; the meters' scale. */
  peaks: Record<string, NetworkRate>
}) {
  const { t } = useTranslation()
  const [showVirtual, setShowVirtual] = useState(false)
  const toggleId = useId()
  const isVirtual = (n: SystemSnapshot['networks'][number]) =>
    isVirtualInterface(n.name, n.mac_address)
  const hiddenCount = snapshot.networks.filter(isVirtual).length
  const shown = showVirtual ? snapshot.networks : snapshot.networks.filter((n) => !isVirtual(n))
  const kindLabel = {
    wifi: t('system-monitor:wifi'),
    ethernet: t('system-monitor:ethernet'),
    other: null,
  }
  return (
    <Panel
      title={t('system-monitor:network')}
      icon={<Icon name="x-globe" size={16} />}
      delay={360}
      className="md:col-span-2 xl:col-span-7"
      actions={
        hiddenCount > 0 ? (
          <label
            htmlFor={toggleId}
            className="flex cursor-pointer items-center gap-2 text-[13px] text-secondary-foreground"
          >
            <input
              id={toggleId}
              type="checkbox"
              checked={showVirtual}
              onChange={(e) => setShowVirtual(e.target.checked)}
            />
            {t('system-monitor:showVirtual', { count: hiddenCount })}
          </label>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3.5">
        {shown.length > 0 && (
          <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Info className="size-3.5 shrink-0" aria-hidden />
            {t('system-monitor:peakScale')}
          </p>
        )}
        {shown.length === 0 ? (
          <Empty>{t('system-monitor:noNetworks')}</Empty>
        ) : (
          shown.map((n) => {
            const rate = rates[n.name]
            const kind = kindLabel[interfaceKind(n.name)]
            return (
              <div
                key={n.name}
                className="flex min-w-0 items-start gap-3.5 rounded-xl border-[0.8px] border-border bg-muted/30 p-3.5"
              >
                <span
                  aria-hidden
                  className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl border-[0.8px] border-border bg-card text-secondary-foreground"
                >
                  <Icon name="x-globe" size={18} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <b className="min-w-0 truncate text-[15px] font-medium text-foreground" title={n.name}>
                      {n.name}
                    </b>
                    {isVirtual(n) ? <Chip>{t('system-monitor:virtual')}</Chip> : kind && <Chip>{kind}</Chip>}
                  </div>
                  <Meter
                    label={t('system-monitor:download')}
                    percent={ratePercent(rate?.rx, peaks[n.name]?.rx)}
                    display={rate ? formatRate(rate.rx) : '—'}
                    color={ACCENT.down}
                    className="mt-0"
                  />
                  <Meter
                    label={t('system-monitor:upload')}
                    percent={ratePercent(rate?.tx, peaks[n.name]?.tx)}
                    display={rate ? formatRate(rate.tx) : '—'}
                    color={ACCENT.up}
                    className="mt-0"
                  />
                  <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 border-t border-border/70 pt-2.5 text-[12.5px] text-muted-foreground">
                    <span>
                      {t('system-monitor:totalReceived')}{' '}
                      <b className="ml-1.5 font-medium text-foreground tabular-nums">
                        {formatBytes(n.total_received)}
                      </b>
                    </span>
                    <span>
                      {t('system-monitor:totalSent')}{' '}
                      <b className="ml-1.5 font-medium text-foreground tabular-nums">
                        {formatBytes(n.total_transmitted)}
                      </b>
                    </span>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </Panel>
  )
}

function TemperaturePanel({ snapshot }: { snapshot: SystemSnapshot }) {
  const { t } = useTranslation()
  const sensors = snapshot.sensors.filter((s) => s.temperature != null)
  const kindLabel = {
    cpu: 'CPU',
    gpu: 'GPU',
    disk: t('system-monitor:drive'),
    other: null,
  }
  return (
    <Panel
      title={t('system-monitor:temperatures')}
      icon={<Icon name="zap" size={16} />}
      delay={420}
      className="md:col-span-2 xl:col-span-5 xl:self-start"
    >
      {sensors.length === 0 ? (
        <Empty>
          {IS_WINDOWS ? t('system-monitor:noSensorsWindows') : t('system-monitor:noSensors')}
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {IS_WINDOWS && !sensors.some((s) => s.kind === 'cpu') && (
            <div className="flex items-start gap-3 rounded-xl border-[0.8px] border-border bg-muted/40 p-3.5 text-[13px] leading-snug text-secondary-foreground">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              {t('system-monitor:noCpuSensorsWindows')}
            </div>
          )}
          {sensors.map((sensor, i) => {
            const temp = sensor.temperature ?? 0
            const kind = kindLabel[sensor.kind]
            const scale = temperatureScale(sensor)
            const percent = clampPercent(scale.percent)
            return (
              <div key={`${sensor.label}-${i}`} className="flex min-w-0 flex-col gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <b className="min-w-0 truncate text-[14px] font-medium text-foreground" title={sensor.label}>
                    {sensor.label}
                  </b>
                  {kind && <Chip mono>{kind}</Chip>}
                </div>
                <div className="flex items-end justify-between gap-2">
                  <span className="text-[12.5px] text-muted-foreground">
                    {scale.limit
                      ? t(`system-monitor:${scale.of}`, { value: formatTemperature(scale.limit) })
                      : t('system-monitor:current')}
                  </span>
                  <b className="text-[15px] font-semibold tabular-nums text-foreground">
                    {formatTemperature(temp)}
                  </b>
                </div>
                <div
                  role="meter"
                  aria-label={
                    scale.limit
                      ? t(`system-monitor:${scale.of}`, { value: formatTemperature(scale.limit) })
                      : t('system-monitor:current')
                  }
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(percent)}
                  className="relative h-1.5 w-full overflow-hidden rounded-full bg-track"
                >
                  <div
                    className={cn('h-full rounded-full', BAND_FILL[band(percent)])}
                    style={{
                      width: `${percent}%`,
                      ...(band(percent) === 'ok'
                        ? { background: 'linear-gradient(90deg,#2fd08a,#7be0a8)' }
                        : null),
                    }}
                  />
                </div>
                <div className="text-[11.5px] text-muted-foreground">
                  {sensor.source}
                  {sensor.max != null && scale.of !== 'ofMax' && (
                    <>
                      {' · '}
                      {t('system-monitor:max')} {formatTemperature(sensor.max)}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}

/** One GPU in the card: name, backend, the "use for models" switch, and its figures. */
function GpuBlock({
  gpu,
  total,
  percent,
  hasUsage,
  history,
  group,
  onToggle,
  onSelect,
}: {
  gpu: GPU
  total: number
  percent: number
  hasUsage: boolean
  history: number[]
  /** The llama.cpp device group for this GPU; absent in the standalone window. */
  group?: GpuGroup
  onToggle: () => void
  onSelect: (deviceId: string) => void
}) {
  const { t } = useTranslation()
  const activated = group?.devices.some((d) => d.activated) ?? false
  const current = group ? selectedDevice(group) : undefined
  return (
    <div className="flex min-w-0 flex-col gap-2.5 border-t border-dashed border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <b className="min-w-0 truncate text-[14px] font-medium text-foreground" title={gpu.name}>
            {gpu.name}
          </b>
          {group && group.devices.length > 1 ? (
            group.devices.map((device) => {
              const on = device.id === current?.id
              return (
                <button
                  key={device.id}
                  type="button"
                  onClick={() => onSelect(device.id)}
                  title={t('settings:hardware.backendSelectDesc')}
                  className={cn(
                    'inline-flex h-[22px] cursor-pointer items-center rounded-md border-[0.8px] px-2 font-mono text-xs transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden pointer-coarse:h-9',
                    on
                      ? 'border-blue-400/60 bg-blue-500/10 text-foreground'
                      : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground'
                  )}
                >
                  {backendLabel(parseDeviceId(device.id).backend)}
                </button>
              )
            })
          ) : (
            <Chip mono>{gpuBackendLabel(gpu)}</Chip>
          )}
        </div>
        {group && (
          <label className="flex shrink-0 items-center gap-2 text-xs text-secondary-foreground">
            <span className="hidden sm:inline">
              {activated ? t('settings:hardware.gpuEnabled') : t('settings:hardware.gpuDisabled')}
            </span>
            <Switch
              checked={activated}
              onCheckedChange={onToggle}
              aria-label={t('settings:hardware.gpuEnabled')}
            />
          </label>
        )}
      </div>
      <Stats>
        {gpu.driver_version && (
          <Stat label={t('system-monitor:driverVersion').replace(/:$/, '')}>
            <span className="font-mono">{gpu.driver_version}</span>
          </Stat>
        )}
        <Stat label={t('system-monitor:vram')}>{formatMegaBytes(total)}</Stat>
        {hasUsage && (
          <>
            <Stat label={t('system-monitor:usedRam')}>
              {formatMegaBytes((total * percent) / 100)}
            </Stat>
            <Stat label={t('system-monitor:freeVram')}>
              {formatMegaBytes(total - (total * percent) / 100)}
            </Stat>
          </>
        )}
        {gpu.nvidia_info?.compute_capability && (
          <Stat label={t('system-monitor:computeCapability').replace(/:$/, '')}>
            <span className="font-mono">{gpu.nvidia_info.compute_capability}</span>
          </Stat>
        )}
        {gpu.vulkan_info?.api_version && (
          <Stat label={t('system-monitor:apiVersion')}>
            <span className="font-mono">{gpu.vulkan_info.api_version}</span>
          </Stat>
        )}
      </Stats>
      {hasUsage && (
        <>
          <UsageLine label={t('system-monitor:vramUsage')} percent={percent} color={ACCENT.gpu} />
          <AreaChart values={history} color={ACCENT.gpu} />
        </>
      )}
    </div>
  )
}

function SystemMonitorContent() {
  const { t } = useTranslation()
  const { hardwareData, systemUsage, updateSystemUsage } = useHardware()
  const serviceHub = useServiceHub()
  const inShell = useHeaderSlot() !== null
  const setActiveModels = useAppState((state) => state.setActiveModels)

  // Extensions never load in the standalone window, so GPU data comes from
  // the hardware plugin (allowed by this window's capabilities), not llamacpp.
  const gpus = hardwareData.gpus ?? []

  // The llama.cpp devices carry the on/off switch; they exist only in the shell.
  const devicesStore = useLlamacppDevices()
  const { devices: llamacppDevices, setActivations, fetchDevices } = devicesStore
  useEffect(() => {
    if (inShell && !IS_MACOS) fetchDevices()
  }, [inShell, fetchDevices])
  const gpuGroups = useMemo(
    () => (inShell && !IS_MACOS ? groupDevices(llamacppDevices) : []),
    [inShell, llamacppDevices]
  )
  const applyActivations = (updates: Record<string, boolean>) => {
    setActivations(updates)
    serviceHub.models().stopAllModels()
    serviceHub
      .models()
      .getActiveModels()
      .then((models) => setActiveModels(models || []))
  }
  const toggleGroup = (group: GpuGroup) => {
    const activated = group.devices.some((device) => device.activated)
    const updates: Record<string, boolean> = {}
    for (const device of group.devices) updates[device.id] = false
    if (!activated) updates[selectedDevice(group).id] = true
    applyActivations(updates)
  }
  const selectBackend = (group: GpuGroup, deviceId: string) => {
    const updates: Record<string, boolean> = {}
    for (const device of group.devices) updates[device.id] = device.id === deviceId
    applyActivations(updates)
  }

  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null)
  const [rates, setRates] = useState<Record<string, NetworkRate>>({})
  const [peaks, setPeaks] = useState<Record<string, NetworkRate>>({})
  const lastSnapshot = useRef<SystemSnapshot | null>(null)

  const pollSnapshot = useCallback(() => {
    serviceHub
      .hardware()
      .getSystemSnapshot()
      .then((next) => {
        if (!next) return
        const nextRates = computeNetworkRates(lastSnapshot.current, next)
        setRates(nextRates)
        setPeaks((p) => {
          const out = { ...p }
          for (const [name, r] of Object.entries(nextRates)) {
            out[name] = {
              rx: Math.max(out[name]?.rx ?? 0, r.rx),
              tx: Math.max(out[name]?.tx ?? 0, r.tx),
            }
          }
          return out
        })
        lastSnapshot.current = next
        setSnapshot(next)
      })
      .catch((error) => {
        console.error('Failed to get system snapshot:', error)
      })
  }, [serviceHub])

  const pollUsage = useCallback(() => {
    serviceHub
      .hardware()
      .getSystemUsage()
      .then((data) => {
        if (data) {
          updateSystemUsage(data)
        }
      })
      .catch((error) => {
        console.error('Failed to get system usage:', error)
      })
  }, [updateSystemUsage, serviceHub])

  // Poll every 5 seconds while the page is visible; a hidden window costs
  // nothing and catches up as soon as it is shown again.
  useEffect(() => {
    if (!pageHidden()) pollSnapshot()
    const intervalId = setInterval(() => {
      if (pageHidden()) return
      pollUsage()
      pollSnapshot()
    }, POLL_MS)
    const onVisibility = () => {
      if (pageHidden()) return
      pollUsage()
      pollSnapshot()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [pollUsage, pollSnapshot])

  // Calculate RAM usage percentage
  const ramUsagePercentage = toNumber(systemUsage.used_memory / hardwareData.total_memory) * 100

  const gpuPercent = (gpu: GPU) => {
    const usage = systemUsage.gpus?.find((u) => u.uuid === gpu.uuid)
    const total = usage?.total_memory || gpu.total_memory
    const used = usage?.used_memory ?? 0
    return { usage, total, percent: total > 0 ? toNumber(used / total) * 100 : 0 }
  }

  // Each poll adds one point to every chart.
  const [history, setHistory] = useState<Record<string, number[]>>({})
  useEffect(() => {
    setHistory((h) => {
      const next: Record<string, number[]> = {
        cpu: pushSample(h.cpu, clampPercent(systemUsage.cpu)),
        ram: pushSample(h.ram, clampPercent(ramUsagePercentage)),
      }
      for (const gpu of hardwareData.gpus ?? []) {
        const { usage, percent } = gpuPercent(gpu)
        if (usage) next[gpu.uuid] = pushSample(h[gpu.uuid], percent)
      }
      return next
    })
    // gpuPercent reads only systemUsage and the gpu passed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemUsage, ramUsagePercentage, hardwareData.gpus])

  const live = (
    <Chip tone="ok" live>
      {t('system-monitor:live')}
    </Chip>
  )
  const firstGpu = gpus[0] ? gpuPercent(gpus[0]) : undefined
  const swapPercent =
    snapshot && snapshot.memory.swap_total > 0
      ? (snapshot.memory.swap_used / snapshot.memory.swap_total) * 100
      : 0

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-card">
      <SystemPageHeader
        title={t('system-monitor:title')}
        icon={<Icon name="x-activity" size={16} />}
        actions={inShell ? undefined : live}
      />

      <div
        className={cn(
          'min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 pb-8 [scrollbar-width:thin]',
          inShell ? 'px-1' : 'px-4'
        )}
      >
        <div className="flex w-full min-w-0 flex-col gap-4">
          {/* In the shell the breadcrumb names the page; the heading here
              matches the other pages. The standalone window's bar already
              carries the title, so it is not repeated. */}
          {inShell && (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-4">
                <IconTile size="lg">
                  <Icon name="x-activity" size={22} />
                </IconTile>
                <div className="flex min-w-0 flex-col gap-2">
                  <h2 className="text-[26px] leading-none font-medium tracking-[-0.01em] text-foreground">
                    {t('system-monitor:title')}
                  </h2>
                  <p className="text-[13px] text-muted-foreground">
                    {t('system-monitor:description')}
                  </p>
                </div>
              </div>
              {live}
            </div>
          )}

          <div className="grid w-full grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-12">
            <Panel
              title={t('system-monitor:cpu')}
              icon={<Icon name="x-cpu" size={16} />}
              delay={60}
              className="xl:col-span-4"
              badge={<Badge color={ACCENT.cpu} percent={systemUsage.cpu} label={t('system-monitor:cpu')}>{systemUsage.cpu.toFixed(2)}%</Badge>}
            >
              <b
                className="mb-3 block truncate text-[14px] font-medium text-foreground"
                title={hardwareData.cpu.name}
              >
                {hardwareData.cpu.name}
              </b>
              <Stats>
                <Stat label={t('system-monitor:cores')}>
                  {snapshot?.cpu.physical_cores ?? hardwareData.cpu.core_count}
                </Stat>
                {snapshot && <Stat label={t('system-monitor:threads')}>{snapshot.cpu.logical_cores}</Stat>}
                {snapshot && snapshot.cpu.frequency_mhz > 0 && (
                  <Stat label={t('system-monitor:frequency')}>
                    {formatFrequency(snapshot.cpu.frequency_mhz)}
                  </Stat>
                )}
                <Stat label={t('system-monitor:architecture')}>
                  <span className="font-mono">{hardwareData.cpu.arch}</span>
                </Stat>
              </Stats>
              <UsageLine
                label={t('system-monitor:currentUsage')}
                percent={systemUsage.cpu}
                color={ACCENT.cpu}
              />
              <AreaChart values={history.cpu ?? []} color={ACCENT.cpu} />
              {snapshot && snapshot.cpu.per_core.length > 1 && (
                <PerCoreUsage values={snapshot.cpu.per_core} />
              )}
            </Panel>

            <Panel
              title={t('system-monitor:memory')}
              icon={<Icon name="x-disk" size={16} />}
              delay={120}
              className="xl:col-span-4"
              badge={<Badge color={ACCENT.memory} percent={ramUsagePercentage} label={t('system-monitor:memory')}>{ramUsagePercentage.toFixed(2)}%</Badge>}
            >
              <Stats>
                <Stat label={t('system-monitor:totalRam')}>
                  {formatMegaBytes(hardwareData.total_memory)}
                </Stat>
                <Stat label={t('system-monitor:availableRam')}>
                  {formatMegaBytes(hardwareData.total_memory - systemUsage.used_memory)}
                </Stat>
                <Stat label={t('system-monitor:usedRam')}>
                  {formatMegaBytes(systemUsage.used_memory)}
                </Stat>
              </Stats>
              <UsageLine
                label={t('system-monitor:currentUsage')}
                percent={ramUsagePercentage}
                color={ACCENT.memory}
              />
              <AreaChart values={history.ram ?? []} color={ACCENT.memory} />
              {snapshot && snapshot.memory.swap_total > 0 && (
                <>
                  <div className="mt-4">
                    <Stats>
                      <Stat label={t('system-monitor:swap')}>
                        {formatBytes(snapshot.memory.swap_used)} /{' '}
                        {formatBytes(snapshot.memory.swap_total)}
                      </Stat>
                    </Stats>
                  </div>
                  <Meter
                    label={t('system-monitor:swapUsage')}
                    percent={swapPercent}
                    color={ACCENT.memory}
                  />
                </>
              )}
            </Panel>

            {!IS_MACOS && (
              <Panel
                title={t('system-monitor:gpu')}
                icon={<Icon name="x-monitor" size={16} />}
                delay={180}
                className="md:col-span-2 xl:col-span-4"
                badge={
                  firstGpu?.usage ? (
                    <Badge color={ACCENT.gpu} percent={firstGpu.percent} label={t('system-monitor:gpu')}>{firstGpu.percent.toFixed(2)}%</Badge>
                  ) : undefined
                }
              >
                <div className="flex flex-col gap-4">
                  {gpus.length > 0 ? (
                    gpus.map((gpu) => {
                      const { usage, total, percent } = gpuPercent(gpu)
                      const group = groupForGpu(gpuGroups, gpu, gpus)
                      return (
                        <GpuBlock
                          key={gpu.uuid}
                          gpu={gpu}
                          total={total}
                          percent={percent}
                          hasUsage={!!usage}
                          history={history[gpu.uuid] ?? []}
                          group={group}
                          onToggle={() => group && toggleGroup(group)}
                          onSelect={(id) => group && selectBackend(group, id)}
                        />
                      )
                    })
                  ) : (
                    <Empty>{t('system-monitor:noGpus')}</Empty>
                  )}
                </div>
              </Panel>
            )}

            {snapshot && (
              <SystemPanel
                snapshot={snapshot}
                cpuName={hardwareData.cpu.name}
                arch={hardwareData.cpu.arch}
                totalMemory={hardwareData.total_memory}
                gpuNames={gpus.map((g) => g.name)}
              />
            )}
            {snapshot && <DrivesPanel snapshot={snapshot} />}
            {snapshot && <NetworkPanel snapshot={snapshot} rates={rates} peaks={peaks} />}
            {snapshot && <TemperaturePanel snapshot={snapshot} />}
          </div>
        </div>
      </div>
    </div>
  )
}
