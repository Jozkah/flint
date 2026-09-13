/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'
import { Activity } from 'lucide-react'
import { useHardware, type GPU } from '@/hooks/useHardware'
import { route } from '@/constants/routes'
import { cn, formatMegaBytes } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { toNumber } from '@/utils/number'
import { useServiceHub } from '@/hooks/useServiceHub'
import { SystemPageHeader } from '@/containers/SystemPageHeader'

export const Route = createFileRoute(route.systemMonitor as any)({
  component: SystemMonitorContent,
})

function gpuBackendLabel(gpu: GPU): string {
  if (gpu.nvidia_info?.compute_capability) return 'CUDA'
  if (gpu.vulkan_info?.api_version) return 'Vulkan'
  return gpu.vendor || 'GPU'
}

/** Fill colour by load: the accent until usage is high enough to matter. */
function meterFill(percent: number): string {
  if (percent >= 90) return 'bg-destructive'
  if (percent >= 75) return 'bg-warning'
  return 'bg-brand'
}

/** A labelled usage bar with its number beside it. */
function Meter({ label, percent }: { label: string; percent: number }) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0))
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="font-mono text-base font-semibold tabular-nums text-foreground">
          {percent.toFixed(2)}%
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
        className="h-2.5 w-full overflow-hidden rounded-full bg-sunken"
      >
        <div
          className={cn('h-full rounded-full transition-[width]', meterFill(clamped))}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right tabular-nums text-foreground">
        {children}
      </span>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card p-4 md:p-5">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  )
}

function SystemMonitorContent() {
  const { t } = useTranslation()
  const { hardwareData, systemUsage, updateSystemUsage } = useHardware()
  const serviceHub = useServiceHub()

  // Extensions never load in this secondary window, so GPU data comes from
  // the hardware plugin (allowed by this window's capabilities), not llamacpp.
  const gpus = hardwareData.gpus ?? []

  // Poll system usage every 5 seconds
  useEffect(() => {
    const intervalId = setInterval(() => {
      serviceHub.hardware().getSystemUsage()
        .then((data) => {
          if (data) {
            updateSystemUsage(data)
          }
        })
        .catch((error) => {
          console.error('Failed to get system usage:', error)
        })
    }, 5000)

    return () => clearInterval(intervalId)
  }, [updateSystemUsage, serviceHub])

  // Calculate RAM usage percentage
  const ramUsagePercentage =
    toNumber(systemUsage.used_memory / hardwareData.total_memory) * 100

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
      <SystemPageHeader
        title={t('system-monitor:title')}
        icon={<Activity className="size-4" />}
      />

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 md:p-6">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {/* CPU Usage Card */}
          <Panel title={t('system-monitor:cpuUsage')}>
            <div className="flex flex-col gap-1.5">
              <Stat label={t('system-monitor:model')}>
                <span title={hardwareData.cpu.name}>{hardwareData.cpu.name}</span>
              </Stat>
              <Stat label={t('system-monitor:cores')}>
                {hardwareData.cpu.core_count}
              </Stat>
              <Stat label={t('system-monitor:architecture')}>
                <span className="font-mono">{hardwareData.cpu.arch}</span>
              </Stat>
            </div>
            <Meter
              label={t('system-monitor:currentUsage')}
              percent={systemUsage.cpu}
            />
          </Panel>

          {/* RAM Usage Card */}
          <Panel title={t('system-monitor:memoryUsage')}>
            <div className="flex flex-col gap-1.5">
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
            </div>
            <Meter
              label={t('system-monitor:currentUsage')}
              percent={ramUsagePercentage}
            />
          </Panel>

          {/* GPU Usage Card */}
          {!IS_MACOS && (
            <Panel title={t('system-monitor:gpus')}>
              <div className="flex flex-col gap-5">
                {gpus.length > 0 ? (
                  gpus.map((gpu) => {
                    const usage = systemUsage.gpus?.find(
                      (u) => u.uuid === gpu.uuid
                    )
                    const total = usage?.total_memory || gpu.total_memory
                    const used = usage?.used_memory ?? 0
                    const usagePercent =
                      total > 0 ? toNumber(used / total) * 100 : 0
                    return (
                      <div
                        key={gpu.uuid}
                        className="flex min-w-0 flex-col gap-1.5 border-t border-border pt-4 first:border-t-0 first:pt-0"
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <span
                            className="min-w-0 truncate text-sm font-medium text-foreground"
                            title={gpu.name}
                          >
                            {gpu.name}
                          </span>
                          <span className="shrink-0 rounded-md border border-border bg-sunken px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-ink-2">
                            {gpuBackendLabel(gpu)}
                          </span>
                        </div>
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
                        {usage && (
                          <Meter
                            label={t('system-monitor:vramUsage')}
                            percent={usagePercent}
                          />
                        )}
                      </div>
                    )
                  })
                ) : (
                  <div className="rounded-md bg-sunken py-4 text-center text-sm text-muted-foreground">
                    {t('system-monitor:noGpus')}
                  </div>
                )}
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}
