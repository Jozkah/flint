import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { CardItem } from '@/containers/Card'
import { useBuildUpdate } from '@/hooks/useBuildUpdate'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * Settings, General: whether a newer nightly build exists. Off by default, so
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
      ? t('settings:general.buildNewer')
      : last?.state === 'current'
        ? t('settings:general.buildCurrent')
        : last?.state === 'unknown'
          ? t('settings:general.buildUnknown')
          : null

  return (
    <CardItem
      anchor="settings-general-build-update"
      title={t('settings:general.buildUpdate')}
      description={
        <>
          {t('settings:general.buildUpdateDesc')}
          {status ? <span className="mt-1 block text-foreground">{status}</span> : null}
        </>
      }
      actions={
        <div className="flex items-center gap-3">
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
