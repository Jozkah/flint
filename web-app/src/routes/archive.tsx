/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { SettingsPageBody } from '@/containers/SettingsPageHeader'
import { ArchivePanel } from '@/containers/archive/ArchivePanel'

export const Route = createFileRoute(route.archive as any)({
  component: ArchivePage,
})

function ArchivePage() {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col" data-testid="archive-page">
      <SettingsPageBody
        title={t('archive:title')}
        description={t('archive:description')}
        width="wide"
      >
        <ArchivePanel />
      </SettingsPageBody>
    </div>
  )
}
