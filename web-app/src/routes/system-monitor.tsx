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

/**
 * Fill colour by load. Neutral until usage is high enough to matter: the
 * accent means "selected", and a busy CPU is not a selection.
 */
function meterFill(percent: number): string {
  if (percent >= 90) return 'bg-destructive'
  if (percent >= 75) return 'bg-warning'
  return 'bg-ink-2'
}

/** A labelled usage bar with its measured number beside it. */
function Meter({ label, percent }: { label: string; percent: number }) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0))
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-mono text-[13px] font-medium tabular-nums text-foreground">
          {percent.toFixed(2)}%
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
        className="h-1.5 w-full overflow-hidden rounded-full bg-accent"
      >
        <div
          className={cn(
            'h-full rounded-full motion-safe:transition-[width]',
            meterFill(clamped)
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 text-[13px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right tabular-nums text-foreground">
        {children}
      </span>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card p-4">
      <h2 className="mb-2.5 text-[13px] font-semibold text-foreground">{title}</h2>
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
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background">
      <SystemPageHeader
        title={t('system-monitor:title')}
        icon={<Activity className="size-4" />}
      />

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 md:p-4">
        <div className="mx-auto grid w-full max-w-[1400px] grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {/* CPU Usage Card */}
          <Panel title={t('system-monitor:cpuUsage')}>
            <div className="flex flex-col gap-1">
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
            <div className="flex flex-col gap-1">
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
              <div className="flex flex-col gap-3">
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
                        className="flex min-w-0 flex-col gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0"
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <span
                            className="min-w-0 truncate text-[13px] font-medium text-foreground"
                            title={gpu.name}
                          >
                            {gpu.name}
                          </span>
                          <span className="shrink-0 rounded-md border border-border bg-sunken px-1.5 py-0.5 font-mono text-xs text-ink-2">
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
                  <div className="rounded-md bg-sunken px-3 py-3 text-[13px] text-muted-foreground">
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
