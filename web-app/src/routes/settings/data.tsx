import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { useTranslation } from '@/i18n/react-i18next-compat'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.data as any)({
  component: DataSettings,
})

function DataSettings() {
  const { t } = useTranslation()
  return (
    <div className="flex h-full w-full flex-col">
      <SettingsPageHeader title={t('common:settingsData')} />
      <SettingsPageBody
        title={t('common:settingsData')}
        description={t('settings:pageDesc.data')}
      >
        <div />
      </SettingsPageBody>
    </div>
  )
}
