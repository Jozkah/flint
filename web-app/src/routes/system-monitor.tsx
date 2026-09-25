/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from '@tanstack/react-router'
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Icon } from '@/components/ui/icon'
import { useHardware, type GPU } from '@/hooks/useHardware'
import { route } from '@/constants/routes'
import { cn, formatMegaBytes } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { toNumber } from '@/utils/number'
import { useServiceHub } from '@/hooks/useServiceHub'
import { SystemPageHeader } from '@/containers/SystemPageHeader'
import { useHeaderSlot } from '@/components/shell/HeaderSlot'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Chip } from '@/components/ui/chip'
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

/** Samples kept per sparkline: two minutes at the 5 second poll. */
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

const BAND_LINE = {
  ok: 'var(--success)',
  warn: 'var(--warning)',
  err: 'var(--destructive)',
}

/** A labelled usage bar with its measured number beside it. */
function Meter({
  label,
  percent,
  display,
}: {
  label: string
  percent: number
  /** Shown instead of the percent, e.g. a rate or a temperature. */
  display?: string
}) {
  const clamped = clampPercent(percent)
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2 text-xs">
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
            BAND_FILL[band(clamped)]
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}

/**
 * Recent samples as a filled line, coloured by the latest value's band. Drawn
 * to the card's width; the stroke keeps its weight however wide that is.
 */
function Sparkline({ values }: { values: number[] }) {
  const id = useId()
  if (values.length < 2) return <div className="mt-2.5 h-[46px]" aria-hidden />
  const n = values.length
  const pts = values.map(
    (v, i) => `${((i / (n - 1)) * 120).toFixed(1)},${(44 - (clampPercent(v) / 100) * 40).toFixed(1)}`
  )
  const color = BAND_LINE[band(values[n - 1])]
  return (
    <svg
      aria-hidden
      viewBox="0 0 120 46"
      preserveAspectRatio="none"
      className="mt-2.5 block h-[46px] w-full"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: color, stopOpacity: 0.22 }} />
          <stop offset="1" style={{ stopColor: color, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <path d={`M0,46L${pts.join('L')}L120,46Z`} fill={`url(#${id})`} />
      <path
        d={`M${pts.join('L')}`}
        fill="none"
        stroke={color}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/** Label/value pairs in the design's two-column key table. */
function Stats({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] items-baseline gap-x-3.5 gap-y-1.5 text-[12.5px]">
      {children}
    </dl>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-fg-2 tabular-nums">{children}</dd>
    </>
  )
}

function Panel({
  title,
  icon,
  delay,
  className,
  children,
}: {
  title: string
  icon: ReactNode
  delay: number
  className?: string
  children: ReactNode
}) {
  return (
    <Frame
      className={cn('motion-safe:animate-rise-in', className)}
      style={{ animationDelay: `${delay}ms` }}
    >
      <FrameHeader icon={icon} title={title} />
      <FrameBody className="p-3.5">{children}</FrameBody>
    </Frame>
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
    <div className="mt-3 border-t border-dashed border-border pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <span>{t('system-monitor:perCore')}</span>
        <span
          aria-hidden
          className={cn('transition-transform', open && 'rotate-180')}
        >
          ▾
        </span>
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
                  <b className="font-medium text-foreground">
                    {Math.round(clamped)}%
                  </b>
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
    <div className="rounded-lg bg-muted px-3 py-3 text-[13px] text-muted-foreground">
      {children}
    </div>
  )
}

/** One entry in a list panel, separated by a dashed rule like the GPUs. */
function Row({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-dashed border-border pt-4 first:border-t-0 first:pt-0">
      {children}
    </div>
  )
}

function RowTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <b
        className="min-w-0 truncate text-[13px] font-medium text-foreground"
        title={title}
      >
        {title}
      </b>
      {children}
    </div>
  )
}

function SystemPanel({ snapshot }: { snapshot: SystemSnapshot }) {
  const { t } = useTranslation()
  return (
    <Panel
      title={t('system-monitor:system')}
      icon={<Icon name="clock-01" size={16} />}
      delay={240}
    >
      <Stats>
        {snapshot.host_name && (
          <Stat label={t('system-monitor:hostName')}>
            <span className="font-mono">{snapshot.host_name}</span>
          </Stat>
        )}
        {snapshot.os_version && (
          <Stat label={t('system-monitor:osVersion')}>
            {snapshot.os_version}
          </Stat>
        )}
        {snapshot.kernel_version && (
          <Stat label={t('system-monitor:kernel')}>
            <span className="font-mono">{snapshot.kernel_version}</span>
          </Stat>
        )}
        <Stat label={t('system-monitor:uptime')}>
          {formatUptime(snapshot.uptime_secs)}
        </Stat>
      </Stats>
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
      className="md:col-span-2"
    >
      {snapshot.disks.length === 0 ? (
        <Empty>{t('system-monitor:noDrives')}</Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {snapshot.disks.map((disk) => {
            const used = disk.total - Math.min(disk.available, disk.total)
            return (
              <div
                key={disk.mount_point}
                data-testid="drive-card"
                className="flex min-w-0 flex-col rounded-lg border border-border px-3 pt-2.5 pb-3"
              >
                <div className="flex min-w-0 items-baseline gap-2">
                  <b className="shrink-0 font-mono text-[13px] font-medium text-foreground">
                    {disk.mount_point}
                  </b>
                  {disk.name && (
                    <span
                      className="min-w-0 truncate text-xs text-muted-foreground"
                      title={disk.name}
                    >
                      {disk.name}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {disk.file_system && <Chip mono>{disk.file_system}</Chip>}
                  {disk.kind !== 'Unknown' && <Chip mono>{disk.kind}</Chip>}
                  {disk.removable && (
                    <Chip tone="info" dot>
                      {t('system-monitor:removable')}
                    </Chip>
                  )}
                </div>
                <Meter
                  label={`${formatBytes(used)} / ${formatBytes(disk.total)}`}
                  percent={diskUsedPercent(disk)}
                />
                <div className="mt-1.5 text-[11.5px] text-muted-foreground tabular-nums">
                  {t('system-monitor:freeOf', {
                    free: formatBytes(disk.available),
                  })}
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
  const shown = showVirtual
    ? snapshot.networks
    : snapshot.networks.filter((n) => !isVirtual(n))
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
    >
      <div className="flex flex-col gap-4">
        {hiddenCount > 0 && (
          <label
            htmlFor={toggleId}
            className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
          >
            <input
              id={toggleId}
              type="checkbox"
              checked={showVirtual}
              onChange={(e) => setShowVirtual(e.target.checked)}
            />
            {t('system-monitor:showVirtual', { count: hiddenCount })}
          </label>
        )}
        {shown.length > 0 && (
          <p className="text-[11.5px] text-muted-foreground">
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
              <Row key={n.name}>
                <RowTitle title={n.name}>
                  {isVirtual(n) ? (
                    <Chip>{t('system-monitor:virtual')}</Chip>
                  ) : (
                    kind && <Chip>{kind}</Chip>
                  )}
                </RowTitle>
                <Meter
                  label={t('system-monitor:download')}
                  percent={ratePercent(rate?.rx, peaks[n.name]?.rx)}
                  display={rate ? formatRate(rate.rx) : '—'}
                />
                <Meter
                  label={t('system-monitor:upload')}
                  percent={ratePercent(rate?.tx, peaks[n.name]?.tx)}
                  display={rate ? formatRate(rate.tx) : '—'}
                />
                <Stats>
                  <Stat label={t('system-monitor:totalReceived')}>
                    {formatBytes(n.total_received)}
                  </Stat>
                  <Stat label={t('system-monitor:totalSent')}>
                    {formatBytes(n.total_transmitted)}
                  </Stat>
                </Stats>
              </Row>
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
    >
      {sensors.length === 0 ? (
        <Empty>
          {IS_WINDOWS
            ? t('system-monitor:noSensorsWindows')
            : t('system-monitor:noSensors')}
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {IS_WINDOWS && !sensors.some((s) => s.kind === 'cpu') && (
            <Empty>{t('system-monitor:noCpuSensorsWindows')}</Empty>
          )}
          {sensors.map((sensor, i) => {
            const temp = sensor.temperature ?? 0
            const kind = kindLabel[sensor.kind]
            const scale = temperatureScale(sensor)
            return (
              <Row key={`${sensor.label}-${i}`}>
                <RowTitle title={sensor.label}>
                  {kind && <Chip mono>{kind}</Chip>}
                </RowTitle>
                <Meter
                  label={
                    scale.limit
                      ? t(`system-monitor:${scale.of}`, {
                          value: formatTemperature(scale.limit),
                        })
                      : t('system-monitor:current')
                  }
                  percent={scale.percent}
                  display={formatTemperature(temp)}
                />
                <div className="text-[11.5px] text-muted-foreground">
                  {sensor.source}
                  {sensor.max != null && scale.of !== 'ofMax' && (
                    <>
                      {' · '}
                      {t('system-monitor:max')} {formatTemperature(sensor.max)}
                    </>
                  )}
                </div>
              </Row>
            )
          })}
        </div>
      )}
    </Panel>
  )
}

function SystemMonitorContent() {
  const { t } = useTranslation()
  const { hardwareData, systemUsage, updateSystemUsage } = useHardware()
  const serviceHub = useServiceHub()
  const inShell = useHeaderSlot() !== null

  // Extensions never load in this secondary window, so GPU data comes from
  // the hardware plugin (allowed by this window's capabilities), not llamacpp.
  const gpus = hardwareData.gpus ?? []

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
  const ramUsagePercentage =
    toNumber(systemUsage.used_memory / hardwareData.total_memory) * 100

  const gpuPercent = (gpu: GPU) => {
    const usage = systemUsage.gpus?.find((u) => u.uuid === gpu.uuid)
    const total = usage?.total_memory || gpu.total_memory
    const used = usage?.used_memory ?? 0
    return { usage, total, percent: total > 0 ? toNumber(used / total) * 100 : 0 }
  }

  // Each poll adds one point to every sparkline.
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
        <div className="flex w-full min-w-0 flex-col gap-6">
          {/* In the shell the breadcrumb names the page; the heading here
              matches the other pages. The standalone window's bar already
              carries the title, so it is not repeated. */}
          {inShell && (
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-3">
                <h2 className="flex items-center gap-2 text-[22px] leading-none font-medium tracking-[-0.01em] text-foreground">
                  <Icon name="x-activity" size={16} />
                  {t('system-monitor:title')}
                </h2>
                <p className="text-[13px] text-muted-foreground">
                  {t('system-monitor:description')}
                </p>
              </div>
              {live}
            </div>
          )}

          <div className="grid w-full grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Panel
              title={t('system-monitor:cpuUsage')}
              icon={<Icon name="x-cpu" size={16} />}
              delay={60}
            >
              <Stats>
                <Stat label={t('system-monitor:model')}>
                  <span title={hardwareData.cpu.name}>{hardwareData.cpu.name}</span>
                </Stat>
                <Stat label={t('system-monitor:cores')}>
                  {snapshot?.cpu.physical_cores ?? hardwareData.cpu.core_count}
                </Stat>
                {snapshot && (
                  <Stat label={t('system-monitor:threads')}>
                    {snapshot.cpu.logical_cores}
                  </Stat>
                )}
                {snapshot && snapshot.cpu.frequency_mhz > 0 && (
                  <Stat label={t('system-monitor:frequency')}>
                    {formatFrequency(snapshot.cpu.frequency_mhz)}
                  </Stat>
                )}
                <Stat label={t('system-monitor:architecture')}>
                  <span className="font-mono">{hardwareData.cpu.arch}</span>
                </Stat>
              </Stats>
              <Meter
                label={t('system-monitor:currentUsage')}
                percent={systemUsage.cpu}
              />
              <Sparkline values={history.cpu ?? []} />
              {snapshot && snapshot.cpu.per_core.length > 1 && (
                <PerCoreUsage values={snapshot.cpu.per_core} />
              )}
            </Panel>

            <Panel
              title={t('system-monitor:memoryUsage')}
              icon={<Icon name="x-disk" size={16} />}
              delay={120}
            >
              <Stats>
                <Stat label={t('system-monitor:totalRam')}>
                  {formatMegaBytes(hardwareData.total_memory)}
                </Stat>
                <Stat label={t('system-monitor:availableRam')}>
                  {formatMegaBytes(
                    hardwareData.total_memory - systemUsage.used_memory
                  )}
                </Stat>
                <Stat label={t('system-monitor:usedRam')}>
                  {formatMegaBytes(systemUsage.used_memory)}
                </Stat>
              </Stats>
              <Meter
                label={t('system-monitor:currentUsage')}
                percent={ramUsagePercentage}
              />
              <Sparkline values={history.ram ?? []} />
              {snapshot && snapshot.memory.swap_total > 0 && (
                <>
                  <div className="mt-3 border-t border-dashed border-border pt-3">
                    <Stats>
                      <Stat label={t('system-monitor:swap')}>
                        {formatBytes(snapshot.memory.swap_used)} /{' '}
                        {formatBytes(snapshot.memory.swap_total)}
                      </Stat>
                    </Stats>
                  </div>
                  <Meter
                    label={t('system-monitor:swapUsage')}
                    percent={
                      (snapshot.memory.swap_used / snapshot.memory.swap_total) *
                      100
                    }
                  />
                </>
              )}
            </Panel>

            {!IS_MACOS && (
              <Panel
                title={t('system-monitor:gpus')}
                icon={<Icon name="x-monitor" size={16} />}
                delay={180}
              >
                <div className="flex flex-col gap-4">
                  {gpus.length > 0 ? (
                    gpus.map((gpu) => {
                      const { usage, total, percent } = gpuPercent(gpu)
                      return (
                        <div
                          key={gpu.uuid}
                          className="flex min-w-0 flex-col gap-2 border-t border-dashed border-border pt-4 first:border-t-0 first:pt-0"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <b
                              className="min-w-0 truncate text-[13px] font-medium text-foreground"
                              title={gpu.name}
                            >
                              {gpu.name}
                            </b>
                            <Chip mono>{gpuBackendLabel(gpu)}</Chip>
                          </div>
                          <Stats>
                            {gpu.driver_version && (
                              <Stat label={t('system-monitor:driverVersion')}>
                                <span className="font-mono">
                                  {gpu.driver_version}
                                </span>
                              </Stat>
                            )}
                            <Stat label={t('system-monitor:vram')}>
                              {formatMegaBytes(total)}
                            </Stat>
                          </Stats>
                          {usage && (
                            <>
                              <Meter
                                label={t('system-monitor:vramUsage')}
                                percent={percent}
                              />
                              <Sparkline values={history[gpu.uuid] ?? []} />
                            </>
                          )}
                        </div>
                      )
                    })
                  ) : (
                    <div className="rounded-lg bg-muted px-3 py-3 text-[13px] text-muted-foreground">
                      {t('system-monitor:noGpus')}
                    </div>
                  )}
                </div>
              </Panel>
            )}

            {snapshot && <SystemPanel snapshot={snapshot} />}
            {snapshot && <DrivesPanel snapshot={snapshot} />}
            {snapshot && <NetworkPanel snapshot={snapshot} rates={rates} peaks={peaks} />}
            {snapshot && <TemperaturePanel snapshot={snapshot} />}
          </div>
        </div>
      </div>
    </div>
  )
}
