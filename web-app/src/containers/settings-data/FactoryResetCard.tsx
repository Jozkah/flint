import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { FactoryResetDialog } from '@/containers/dialogs'
import { useHardware } from '@/hooks/useHardware'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isServedByFlint } from '@/lib/platform/utils'
import { runFactoryReset } from '@/lib/runFactoryReset'
import type { FactoryResetOptions } from '@/services/app/types'

/** The danger zone: factory reset, desktop only. */
export function FactoryResetCard({
  janDataFolder,
}: {
  /** The data folder if already known; asked for otherwise. */
  janDataFolder: string | undefined
}): React.ReactElement {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { pausePolling, resumePolling } = useHardware()

  const resetApp = (options: FactoryResetOptions) =>
    runFactoryReset(options, {
      // F6m-025: the folder may not have loaded yet; ask for it instead of
      // treating "unknown" as the root directory.
      getDataFolder: async () =>
        janDataFolder ?? (await serviceHub.app().getJanDataFolder()),
      factoryReset: (o) => serviceHub.app().factoryReset(o),
      pausePolling,
      resumePolling,
      onRootDir: () =>
        toast.error(t('settings:general.couldNotResetRootDirectory')),
      onError: (error) =>
        toast.error(
          t('settings:general.factoryResetFailed', { error: String(error) })
        ),
    })

  return (
    <Card
      title={t('settings:data.dangerGroup', {
        defaultValue: 'Danger zone',
      })}
    >
      <CardItem
        anchor="settings-data-factory-reset"
        title={t('settings:others.resetFactory', {
          ns: 'settings',
        })}
        description={t('settings:others.resetFactoryDesc', {
          ns: 'settings',
        })}
        actions={
          // Resetting wipes the desktop app's data; a browser cannot.
          isServedByFlint() ? (
            <span className="text-xs text-muted-foreground" data-testid="factory-reset-desktop-only">
              {t('permissions:desktopOnly')}
            </span>
          ) : (
            <FactoryResetDialog onReset={resetApp}>
              <Button variant="destructive">{t('common:reset')}</Button>
            </FactoryResetDialog>
          )
        }
      />
    </Card>
  )
}
