import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { SettingsPageBody, SettingsPageHeader } from '@/containers/SettingsPageHeader'
import { JevSettingsCard } from '@/containers/JevSettingsCard'
import { useTranslation } from '@/i18n/react-i18next-compat'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.jev as any)({
  component: JevSettings,
})

/** Jev decision support: the key, the two opt-ins, and recent decisions. */
function JevSettings() {
  const { t } = useTranslation()
  return (
    <div className="flex h-full w-full flex-col">
      <SettingsPageHeader title={t('common:jev.tab')} />
      <SettingsPageBody title={t('common:jev.title')} description={t('common:jev.pageDesc')}>
        <JevSettingsCard
          anchors={{
            key: 'settings-jev-key',
            skills: 'settings-jev-skills',
            rerank: 'settings-jev-rerank',
          }}
        />
      </SettingsPageBody>
    </div>
  )
}
