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
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { errorText } from '@/lib/errorText'
import {
  scheduleOsDisable,
  scheduleOsEnable,
  scheduleOsStatus,
  type OsSchedulerStatus,
} from '@/lib/schedules'

/**
 * "Run when the app is closed": an opt-in entry in the operating system's own
 * scheduler. Off by default; turning it on first shows exactly what will be
 * written and run, and turning it off removes all of it.
 */
export function OsSchedulerCard() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<OsSchedulerStatus | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await scheduleOsStatus())
    } catch {
      // Outside the desktop app there is nothing to show.
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (!status) return null

  const apply = async (enable: boolean) => {
    setBusy(true)
    try {
      const next = enable ? await scheduleOsEnable() : await scheduleOsDisable()
      setStatus(next)
      if (next.detail) toast.error(t('schedules:os.failed'), { description: next.detail })
    } catch (e) {
      toast.error(t('schedules:os.failed'), { description: errorText(e) })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <>
      <Card title={t('schedules:os.title')} description={t('schedules:os.description')}>
        <CardItem
          title={t('schedules:os.switch')}
          align="start"
          description={
            <span data-testid="os-status" className="flex flex-col gap-1.5">
              <span>
                {status.installed
                  ? t('schedules:os.on', {
                      platform: status.platformLabel,
                      minutes: status.intervalMinutes,
                    })
                  : t('schedules:os.off')}
              </span>
              <span className="text-subtle-foreground">{t('schedules:os.caveat')}</span>
              {status.detail && (
                <span role="alert" className="text-destructive">
                  {status.detail}
                </span>
              )}
              <span>
                {t('schedules:os.runs')}{' '}
                <code className="font-mono text-[11px] break-all text-secondary-foreground">
                  {status.tickCommand}
                </code>
              </span>
            </span>
          }
          actions={
            <Switch
              checked={status.installed}
              disabled={busy}
              aria-label={t('schedules:os.switch')}
              onCheckedChange={(on) => (on ? setConfirming(true) : void apply(false))}
            />
          }
        />
      </Card>

      <Dialog open={confirming} onOpenChange={(o) => !o && !busy && setConfirming(false)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('schedules:os.confirmTitle', { platform: status.platformLabel })}</DialogTitle>
            <DialogDescription>{t('schedules:os.confirmBody')}</DialogDescription>
          </DialogHeader>
          <ul
            data-testid="os-preview"
            className="flex flex-col gap-1 rounded-md border-[0.8px] border-border bg-card p-3 font-mono text-[11px] break-all text-secondary-foreground"
          >
            {status.preview.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t('schedules:os.confirmUndo')}</p>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              {t('common:cancel')}
            </Button>
            <Button disabled={busy} onClick={() => void apply(true)}>
              {t('schedules:os.install')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
