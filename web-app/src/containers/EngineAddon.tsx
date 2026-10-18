/**
 * The NVIDIA CUDA engine add-on in the UI: the offer card that appears after a
 * local model loads on an eligible machine, and the "Engine add-ons" panel in
 * System Monitor and the llama.cpp settings. Nothing downloads without a
 * click. Off the desktop (browser client, `flint serve`), and on AMD, Intel,
 * old NVIDIA GPUs or macOS, neither renders anything.
 */
import { useEffect } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAppState } from '@/hooks/useAppState'
import { useEngineAddon, offerView } from '@/hooks/useEngineAddon'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useLlamacppDevices } from '@/hooks/useLlamacppDevices'
import { cn, formatBytes } from '@/lib/utils'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Icon } from '@/components/ui/icon'
import {
  TYPICAL_PACK_MB,
  addonsAvailableHere,
  hasUsableAddon,
  type AddonFailure,
  type AddonProgress,
} from '@/services/engineAddon'

type T = (key: string, options?: Record<string, unknown>) => string

function failureText(t: T, failure: AddonFailure | null): string {
  if (!failure) return ''
  switch (failure.code) {
    case 'offline':
      return t('engine:addon.errors.offline')
    case 'not_published':
      return t('engine:addon.errors.notPublished')
    case 'disk_space':
      return t('engine:addon.errors.diskSpace')
    case 'bad_signature':
    case 'corrupt':
    case 'unsafe_archive':
    case 'bad_manifest':
      return t('engine:addon.errors.verify')
    case 'mismatch':
      return t('engine:addon.errors.mismatch')
    default:
      return failure.message
  }
}

function progressLine(t: T, p: AddonProgress | null): { text: string; percent: number | null } {
  if (!p || p.phase === 'install') return { text: t('engine:addon.installing'), percent: null }
  if (p.phase === 'verify') return { text: t('engine:addon.verifying'), percent: null }
  const percent = p.total > 0 ? Math.floor((p.received / p.total) * 100) : 0
  return {
    text: t('engine:addon.downloading', {
      received: formatBytes(p.received),
      total: formatBytes(p.total),
    }),
    percent,
  }
}

function packSize(remoteBytes: number | undefined): string {
  return formatBytes(remoteBytes ?? TYPICAL_PACK_MB * 1024 * 1024)
}

/** Keeps the add-on status fresh and notes the first local model load. */
function useEngineAddonWatcher() {
  const refresh = useEngineAddon((s) => s.refresh)
  const checkRemote = useEngineAddon((s) => s.checkRemote)
  const noteModelLoaded = useEngineAddon((s) => s.noteModelLoaded)
  const loadedCount = useAppState((s) => s.activeModels.length)
  useEffect(() => {
    if (!addonsAvailableHere()) return
    void refresh()
  }, [refresh])
  useEffect(() => {
    if (!addonsAvailableHere() || loadedCount === 0) return
    noteModelLoaded()
    void refresh().then((status) => {
      if (status?.eligibility === 'eligible' && !hasUsableAddon(status)) void checkRemote()
    })
  }, [loadedCount, noteModelLoaded, refresh, checkRemote])
}

/** The floating, non-blocking card. Mounted once in the main window. */
export function EngineAddonOffer() {
  useEngineAddonWatcher()
  const { t } = useTranslation()
  const state = useEngineAddon()
  const view = offerView(state)
  if (!addonsAvailableHere() || !view) return null
  const { status, remote, progress, error } = state

  const close = (forever = false) =>
    view === 'driver' ? state.dismissDriverNotice() : state.dismiss(forever)

  let title = t('engine:addon.offerTitle')
  let body: React.ReactNode = t('engine:addon.offerBody', {
    size: packSize(remote?.archive_size),
  })
  let actions: React.ReactNode = (
    <>
      <Button size="sm" onClick={() => void state.download()}>
        {t('engine:addon.download')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => close(false)}>
        {t('engine:addon.notNow')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => close(true)}>
        {t('engine:addon.dontRemind')}
      </Button>
    </>
  )
  if (view === 'progress') {
    const line = progressLine(t, progress)
    title = t('engine:addon.gettingTitle')
    body = (
      <div className="flex flex-col gap-2">
        <span>{line.text}</span>
        <Progress value={line.percent ?? 100} className={cn(line.percent == null && 'animate-pulse')} />
        <span className="text-muted-foreground">{t('engine:addon.vulkanMeanwhile')}</span>
      </div>
    )
    actions =
      progress?.phase === 'download' || !progress ? (
        <Button size="sm" variant="outline" onClick={() => void state.cancel()}>
          {t('engine:addon.cancel')}
        </Button>
      ) : null
  } else if (view === 'installed') {
    title = t('engine:addon.installedTitle')
    body = t('engine:addon.installedBody')
    actions = (
      <Button size="sm" variant="outline" onClick={() => close(false)}>
        {t('engine:addon.ok')}
      </Button>
    )
  } else if (view === 'failed') {
    title = t('engine:addon.failedTitle')
    body = failureText(t, error)
    actions = (
      <>
        <Button size="sm" onClick={() => void state.download()}>
          {t('engine:addon.retry')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => close(false)}>
          {t('engine:addon.notNow')}
        </Button>
      </>
    )
  } else if (view === 'driver') {
    title = t('engine:addon.driverTitle')
    body = t('engine:addon.driverBody', {
      current: status?.driver_version ?? '?',
      min: status?.min_driver ?? 580,
    })
    actions = (
      <Button size="sm" variant="outline" onClick={() => close()}>
        {t('engine:addon.ok')}
      </Button>
    )
  }

  return (
    <aside
      role="status"
      aria-live="polite"
      data-testid="engine-addon-offer"
      data-view={view}
      className="fixed right-4 bottom-4 z-50 flex w-[min(380px,calc(100vw-32px))] flex-col gap-2.5 rounded-2xl border-[0.8px] border-border bg-card p-4 text-[length:calc(var(--ui-font-base)*0.8125)] text-secondary-foreground shadow-lift motion-safe:animate-rise-in"
    >
      <div className="flex items-start justify-between gap-3">
        <b className="text-[length:calc(var(--ui-font-base)*0.875)] font-medium text-foreground">{title}</b>
        {view !== 'progress' && (
          <button
            type="button"
            aria-label={t('engine:addon.close')}
            onClick={() => close(false)}
            className="-m-1 rounded-md p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="leading-relaxed">{body}</div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </aside>
  )
}

function addonRelevant(status: ReturnType<typeof useEngineAddon.getState>['status']): boolean {
  if (!status) return false
  return (
    status.installed.length > 0 ||
    status.eligibility === 'eligible' ||
    status.eligibility === 'driver_too_old'
  )
}

/** The panel in a settings frame, for the llama.cpp settings page. */
export function EngineAddonFrame({ className }: { className?: string }) {
  const { t } = useTranslation()
  const status = useEngineAddon((s) => s.status)
  const refresh = useEngineAddon((s) => s.refresh)
  useEffect(() => {
    if (addonsAvailableHere()) void refresh()
  }, [refresh])
  if (!addonsAvailableHere() || !addonRelevant(status)) return null
  return (
    <Frame className={className}>
      <FrameHeader icon={<Icon name="x-monitor" />} title={t('engine:addon.panelTitle')} />
      <FrameBody className="gap-2 p-3">
        <p className="text-xs text-muted-foreground">{t('engine:addon.panelDesc')}</p>
        <EngineAddonPanel />
      </FrameBody>
    </Frame>
  )
}

/**
 * "Engine add-ons": what is installed, and Download / Remove / Install from
 * file / Check again. Renders nothing where no add-on applies (AMD, Intel, no
 * GPU, macOS, browser client).
 */
export function EngineAddonPanel({ className }: { className?: string }) {
  const { t } = useTranslation()
  const state = useEngineAddon()
  const serviceHub = useServiceHub()
  const fetchDevices = useLlamacppDevices((s) => s.fetchDevices)
  const { status, remote, phase, progress, error } = state
  useEffect(() => {
    if (!addonsAvailableHere()) return
    void state.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (phase === 'installed' || phase === 'idle') void fetchDevices()
  }, [phase, fetchDevices])

  if (!addonsAvailableHere() || !addonRelevant(status) || !status) return null

  const installed = status.installed[0]
  const usable = hasUsableAddon(status)
  const busy = phase === 'downloading'
  const line = busy ? progressLine(t, progress) : null

  const pickFile = async () => {
    const picked = await serviceHub
      .dialog()
      .open({ multiple: false, directory: false, filters: [{ name: 'Flint engine add-on', extensions: ['zip'] }] })
      .catch(() => null)
    if (typeof picked === 'string' && picked) await state.installFile(picked)
  }

  let summary: string
  if (!status.supported) summary = t('engine:addon.unavailableBuild')
  else if (busy) summary = line?.text ?? ''
  else if (usable && installed)
    summary = t('engine:addon.installedVersion', {
      version: installed.release_tag,
      size: formatBytes(installed.size),
    })
  else if (installed && !installed.compatible) summary = t('engine:addon.repairNeeded')
  else if (status.eligibility === 'driver_too_old')
    summary = t('engine:addon.driverBody', {
      current: status.driver_version ?? '?',
      min: status.min_driver,
    })
  else summary = t('engine:addon.notInstalledOffer', { size: packSize(remote?.archive_size) })

  return (
    <section
      data-testid="engine-addon-panel"
      className={cn('flex min-w-0 flex-col gap-3 text-[length:calc(var(--ui-font-base)*0.8125)]', className)}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <b className="text-[length:calc(var(--ui-font-base)*0.875)] font-medium text-foreground">
            {t('engine:addon.cudaName')}
            {usable && status.in_use && (
              <span className="ml-2 rounded-md border-[0.8px] border-border px-1.5 py-0.5 font-mono text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground">
                {t('engine:addon.inUse')}
              </span>
            )}
          </b>
          <span className="text-secondary-foreground">{summary}</span>
          {usable && status.restart_pending && !busy && (
            <span className="text-muted-foreground">{t('engine:addon.installedBody')}</span>
          )}
          {phase === 'failed' && error && (
            <span className="text-destructive">{failureText(t, error)}</span>
          )}
        </div>
      </div>
      {busy && <Progress value={line?.percent ?? 100} />}
      {status.supported && (
        <div className="flex flex-wrap gap-2">
          {busy ? (
            progress?.phase !== 'verify' && progress?.phase !== 'install' ? (
              <Button size="sm" variant="outline" onClick={() => void state.cancel()}>
                {t('engine:addon.cancel')}
              </Button>
            ) : null
          ) : (
            <>
              {!usable && status.eligibility === 'eligible' && (
                <Button size="sm" onClick={() => void state.download()}>
                  {installed ? t('engine:addon.repair') : t('engine:addon.download')}
                </Button>
              )}
              {installed && (
                <Button size="sm" variant="outline" onClick={() => void state.remove()}>
                  {t('engine:addon.remove')}
                </Button>
              )}
              {status.eligibility !== 'driver_too_old' && (
                <Button size="sm" variant="outline" onClick={() => void pickFile()}>
                  {t('engine:addon.installFile')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void (installed ? state.verify() : state.checkRemote().then(() => state.refresh()))}
              >
                {t('engine:addon.checkAgain')}
              </Button>
            </>
          )}
        </div>
      )}
      {status.eligibility === 'eligible' && (
        <label className="flex items-center justify-between gap-3 text-secondary-foreground">
          <span>{t('engine:addon.remindSetting')}</span>
          <Switch
            checked={!state.neverRemind}
            onCheckedChange={(on) => state.setNeverRemind(!on)}
            aria-label={t('engine:addon.remindSetting')}
          />
        </label>
      )}
    </section>
  )
}
