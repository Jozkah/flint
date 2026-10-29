import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import {
  SettingsTabStrip,
  useSettingsTab,
  type SettingsTab,
} from '@/containers/SettingsTabs'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useEffect, useState } from 'react'
import { SettingsBackupCard } from '@/containers/SettingsBackupCard'
import { DataBackupCard } from '@/containers/DataBackupCard'
import { BulkConversationsCard } from '@/containers/BulkConversationsCard'
import { useServiceHub } from '@/hooks/useServiceHub'
import { isPlatformTauri } from '@/lib/platform/utils'
import { DataFolderCard } from '@/containers/settings-data/DataFolderCard'
import { DataImportCard } from '@/containers/settings-data/DataImportCard'
import { FactoryResetCard } from '@/containers/settings-data/FactoryResetCard'

export const Route = createFileRoute(route.settings.data)({
  component: DataSettings,
})

type DataTab = 'storage' | 'cleanup'

function DataSettings() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const tabs: SettingsTab<DataTab>[] = [
    {
      id: 'storage',
      label: t('settings:data.tabStorage', { defaultValue: 'Storage' }),
      anchors: [
        'settings-data-data-folder',
        'settings-data-logs',
        'settings-data-backup*',
        'settings-data-migrate-from-jan',
        'settings-data-import-chatgpt',
      ],
    },
    {
      id: 'cleanup',
      label: t('settings:data.tabCleanup', { defaultValue: 'Cleanup' }),
      anchors: [
        'settings-data-bulk-conversations',
        'settings-data-factory-reset',
      ],
    },
  ]
  const [tab, setTab] = useSettingsTab(tabs)

  // Shared by the folder card (shown, relocated) and factory reset (wiped).
  const [janDataFolder, setJanDataFolder] = useState<string | undefined>()
  const [unavailableDataFolder, setUnavailableDataFolder] = useState<
    string | undefined
  >()

  useEffect(() => {
    const fetchDataFolder = async () => {
      const path = await serviceHub.app().getJanDataFolder()
      setJanDataFolder(path)
      setUnavailableDataFolder(
        await serviceHub.app().getUnavailableJanDataFolder?.()
      )
    }

    fetchDataFolder()
  }, [serviceHub])

  return (
    <div className="flex h-full w-full flex-col">
      <SettingsPageHeader title={t('common:settingsData')} />
      <SettingsPageBody
        title={t('common:settingsData')}
        description={t('settings:pageDesc.data')}
        actions={
          <SettingsTabStrip
            tabs={tabs}
            value={tab}
            onChange={setTab}
            label={t('common:settingsData')}
          />
        }
        // Slots count hidden groups, so each tab keeps its own columns.
        layout={[0, 1, 1, 1, 0, 1]}
      >
        {/* Location - Desktop only */}
        {tab === 'storage' && isPlatformTauri() && (
          <DataFolderCard
            janDataFolder={janDataFolder}
            setJanDataFolder={setJanDataFolder}
            unavailableDataFolder={unavailableDataFolder}
          />
        )}

        {tab === 'storage' && IS_TAURI && <SettingsBackupCard />}

        {tab === 'storage' && IS_TAURI && <DataBackupCard />}

        {/* Import - Desktop only */}
        {tab === 'storage' && isPlatformTauri() && <DataImportCard />}

        {tab === 'cleanup' && (
          <BulkConversationsCard anchor="settings-data-bulk-conversations" />
        )}

        {/* Danger zone, last */}
        {tab === 'cleanup' && <FactoryResetCard janDataFolder={janDataFolder} />}

        {/* The storage groups above are desktop-only: say so instead of a blank page. */}
        {tab === 'storage' && !isPlatformTauri() && (
          <Card>
            <CardItem title={t('permissions:desktopOnly')} />
          </Card>
        )}
      </SettingsPageBody>
    </div>
  )
}
