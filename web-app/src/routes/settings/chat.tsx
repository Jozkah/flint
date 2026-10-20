import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { useTranslation } from '@/i18n/react-i18next-compat'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.chat as any)({
  component: ChatSettings,
})

function ChatSettings() {
  const { t } = useTranslation()
  return (
    <div className="flex h-full w-full flex-col">
      <SettingsPageHeader title={t('common:settingsChat')} />
      <SettingsPageBody
        title={t('common:settingsChat')}
        description={t('settings:pageDesc.chat')}
      >
        <div />
      </SettingsPageBody>
    </div>
  )
}
