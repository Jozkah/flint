import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { errorText } from '@/lib/errorText'
import { autostartGet, autostartSet, type AutostartStatus } from '@/lib/autostart'

/**
 * "Start with the computer" and "Start minimized". Off by default. Turning the
 * first on shows exactly what will be written to the OS startup list and waits
 * for a confirmation; turning it off applies at once and removes the entry.
 * Renders nothing outside the desktop app.
 */
export function StartupItems() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<AutostartStatus | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [minimizedChoice, setMinimizedChoice] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await autostartGet())
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (!status) return null

  const apply = async (enable: boolean, minimized: boolean) => {
    setBusy(true)
    try {
      const next = await autostartSet(enable, minimized)
      setStatus(next)
      if (next.detail) toast.error(t('settings:startup.failed'), { description: next.detail })
    } catch (e) {
      toast.error(t('settings:startup.failed'), { description: errorText(e) })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const openConfirm = async () => {
    setMinimizedChoice(false)
    try {
      setStatus(await autostartGet(false))
    } catch {
      // keep the last preview
    }
    setConfirming(true)
  }

  const onMinimizedPreview = async (value: boolean) => {
    setMinimizedChoice(value)
    try {
      setStatus(await autostartGet(value))
    } catch {
      // keep the last preview
    }
  }

  return (
    <>
      <CardItem
        anchor="settings-general-start-with-computer"
        title={t('settings:startup.title')}
        align="start"
        description={
          <span data-testid="startup-status" className="flex flex-col gap-1.5">
            <span>
              {status.enabled
                ? t('settings:startup.on', { platform: status.platformLabel })
                : t('settings:startup.off')}
            </span>
            {status.detail && (
              <span role="alert" className="text-destructive">
                {status.detail}
              </span>
            )}
          </span>
        }
        actions={
          <Switch
            checked={status.enabled}
            disabled={busy}
            aria-label={t('settings:startup.title')}
            onCheckedChange={(on) => (on ? void openConfirm() : void apply(false, false))}
          />
        }
      />
      {status.enabled && (
        <CardItem
          anchor="settings-general-start-minimized"
          title={t('settings:startup.minimized')}
          description={t('settings:startup.minimizedDesc')}
          actions={
            <Switch
              checked={status.minimized}
              disabled={busy}
              aria-label={t('settings:startup.minimized')}
              onCheckedChange={(on) => void apply(true, on)}
            />
          }
        />
      )}

      <Dialog open={confirming} onOpenChange={(o) => !o && !busy && setConfirming(false)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('settings:startup.confirmTitle', { platform: status.platformLabel })}</DialogTitle>
            <DialogDescription>{t('settings:startup.confirmBody')}</DialogDescription>
          </DialogHeader>
          <ul
            data-testid="startup-preview"
            className="flex flex-col gap-1 rounded-md border-[0.8px] border-border bg-card p-3 font-mono text-[11px] break-all text-secondary-foreground"
          >
            {status.preview.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={minimizedChoice}
              disabled={busy}
              aria-label={t('settings:startup.minimized')}
              onCheckedChange={(v) => void onMinimizedPreview(v)}
            />
            {t('settings:startup.minimized')}
          </label>
          <p className="text-xs text-muted-foreground">{t('settings:startup.confirmUndo')}</p>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              {t('common:cancel')}
            </Button>
            <Button disabled={busy} onClick={() => void apply(true, minimizedChoice)}>
              {t('settings:startup.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
