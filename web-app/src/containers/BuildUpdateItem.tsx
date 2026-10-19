import { useState } from 'react'
import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Switch } from '@/components/ui/switch'
import { CardItem } from '@/containers/Card'
import { useBuildUpdate } from '@/hooks/useBuildUpdate'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * Settings, General: whether a newer stable release exists. Off by default, so
 * Flint asks GitHub nothing until the person turns this on or presses Check now.
 */
export function BuildUpdateItem() {
  const { t } = useTranslation()
  const enabled = useBuildUpdate((s) => s.enabled)
  const setEnabled = useBuildUpdate((s) => s.setEnabled)
  const last = useBuildUpdate((s) => s.last)
  const run = useBuildUpdate((s) => s.run)
  const [busy, setBusy] = useState(false)

  const check = async () => {
    setBusy(true)
    try {
      await run({ manual: true })
    } finally {
      setBusy(false)
    }
  }

  const status =
    last?.state === 'newer'
      ? t('settings:general.buildNewer', { version: last.latest })
      : last?.state === 'current'
        ? t('settings:general.buildCurrent')
        : last?.state === 'unknown'
          ? t('settings:general.buildUnknown')
          : null

  return (
    <CardItem
      anchor="settings-general-build-update"
      title={
        // The explanation is long; it sits in a tooltip so the row stays one line.
        <span className="inline-flex items-center gap-1.5">
          {t('settings:general.buildUpdate')}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={t('settings:general.buildUpdateDesc')}
              >
                <Info className="size-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">
              <p>{t('settings:general.buildUpdateDesc')}</p>
            </TooltipContent>
          </Tooltip>
        </span>
      }
      description={status ? <span className="text-foreground">{status}</span> : undefined}
      actions={
        <div className="flex items-center gap-3">
          {last?.state === 'newer' && (
            <Button size="sm" onClick={() => void getServiceHub().opener().openUrl(last.url)}>
              {t('settings:general.buildDownload')}
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void check()}>
            {busy ? t('settings:general.buildChecking') : t('settings:general.buildCheckNow')}
          </Button>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={t('settings:general.buildUpdate')}
          />
        </div>
      }
    />
  )
}
