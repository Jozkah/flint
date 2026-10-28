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
import { useThreads } from '@/hooks/useThreads'
import { Button } from '@/components/ui/button'
import { useMigrationAssistant } from '@/stores/migration-assistant-store'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useEffect, useRef, useState } from 'react'
import ChangeDataFolderLocation from '@/containers/dialogs/ChangeDataFolderLocation'
import { FactoryResetDialog } from '@/containers/dialogs'
import { SettingsBackupCard } from '@/containers/SettingsBackupCard'
import { BulkConversationsCard } from '@/containers/BulkConversationsCard'
import type { FactoryResetOptions } from '@/services/app/types'
import { useServiceHub } from '@/hooks/useServiceHub'
import { Copy, CopyCheck } from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { toast } from 'sonner'
import { SystemEvent } from '@/types/events'
import { isPlatformTauri, isServedByFlint } from '@/lib/platform/utils'
import { useHardware } from '@/hooks/useHardware'
import { isRootDir } from '@/utils/path'
import { runFactoryReset } from '@/lib/runFactoryReset'
import {
  importConversations,
  parseChatGptExport,
} from '@/lib/chatgptImport'

 
export const Route = createFileRoute(route.settings.data)({
  component: DataSettings,
})

type DataTab = 'storage' | 'cleanup'

function DataSettings() {
  const { t } = useTranslation()
  const openMigrationAssistant = useMigrationAssistant((s) => s.openAssistant)
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

  const openFileTitle = (): string => {
    if (IS_MACOS) {
      return t('settings:general.showInFinder')
    } else if (IS_WINDOWS) {
      return t('settings:general.showInFileExplorer')
    } else {
      return t('settings:general.openContainingFolder')
    }
  }
  const { pausePolling, resumePolling } = useHardware()
  const [janDataFolder, setJanDataFolder] = useState<string | undefined>()
  const [unavailableDataFolder, setUnavailableDataFolder] = useState<
    string | undefined
  >()
  const chatGptFileInput = useRef<HTMLInputElement>(null)
  const [isCopied, setIsCopied] = useState(false)
  const [selectedNewPath, setSelectedNewPath] = useState<string | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)

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

  const handleOpenLogs = async () => {
    try {
      await serviceHub.window().openLogsWindow()
    } catch (error) {
      console.error('Failed to open logs window:', error)
    }
  }

  const handleImportChatGpt = async (file: File | undefined) => {
    if (!file) return
    try {
      const conversations = parseChatGptExport(await file.text())
      if (conversations.length === 0) {
        toast.info(t('settings:general.importChatGptNone'))
        return
      }
      const { threads, failed } = await importConversations(conversations, {
        createThread: (thread) => serviceHub.threads().createThread(thread),
        createMessage: (message) => serviceHub.messages().createMessage(message),
      })
      if (threads.length > 0) {
        const store = useThreads.getState()
        store.setThreads([...threads, ...Object.values(store.threads)])
      }
      if (failed > 0) {
        toast.warning(t('settings:general.importChatGptFailed'), {
          description: `${failed} / ${conversations.length}`,
        })
      }
      if (threads.length > 0) {
        toast.success(
          t('settings:general.importChatGptDone', { count: threads.length })
        )
      }
    } catch (error) {
      toast.error(t('settings:general.importChatGptFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleExportLogs = async () => {
    try {
      const path = await serviceHub.app().exportRedactedLogs()
      if (!path) return
      toast.success(t('settings:general.exportLogsSaved', { path }))
    } catch (error) {
      toast.error(t('settings:general.exportLogsFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000) // Reset after 2 seconds
    } catch (error) {
      console.error('Failed to copy to clipboard:', error)
    }
  }

  const handleDataFolderChange = async () => {
    const selectedPath = await serviceHub.dialog().open({
      multiple: false,
      directory: true,
      defaultPath: janDataFolder,
    })

    if (selectedPath === janDataFolder) return
    if (selectedPath !== null) {
      // Reject a drive/filesystem root up front, before the confirm dialog
      // can stop models or kill the sidecar (e.g. C:\ on Windows, / on Unix).
      if (isRootDir(selectedPath as string)) {
        toast.error(t('settings:general.couldNotRelocateToRoot'))
        return
      }
      setSelectedNewPath(selectedPath as string)
      setIsDialogOpen(true)
    }
  }

  const confirmDataFolderChange = async () => {
    if (selectedNewPath) {
      // Validate before any destructive step: stopping models and killing the
      // sidecar for a path that will be rejected anyway is needless disruption.
      if (isRootDir(selectedNewPath)) {
        toast.error(t('settings:general.couldNotRelocateToRoot'))
        return
      }
      try {
        await serviceHub.models().stopAllModels()
        serviceHub.events().emit(SystemEvent.KILL_SIDECAR)
        setTimeout(async () => {
          try {
            await serviceHub.app().relocateJanDataFolder(selectedNewPath)
            setJanDataFolder(selectedNewPath)
            // Only relaunch if relocation was successful
            window.core?.api?.relaunch()
            setSelectedNewPath(null)
            setIsDialogOpen(false)
          } catch (error) {
            console.error(error)
            toast.error(
              error instanceof Error
                ? error.message
                : t('settings:general.failedToRelocateDataFolder')
            )
          }
        }, 1000)
      } catch (error) {
        console.error('Failed to relocate data folder:', error)
        // Revert the data folder path on error
        const originalPath = await serviceHub.app().getJanDataFolder()
        setJanDataFolder(originalPath)

        toast.error(t('settings:general.failedToRelocateDataFolderDesc'))
      }
    }
  }

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
        layout={[0, 1, 1, 0, 1]}
      >
        {/* Location - Desktop only */}
        {tab === 'storage' && isPlatformTauri() && (
          <Card title={t('common:dataFolder')}>
            <CardItem
              anchor="settings-data-data-folder"
              title={t('settings:dataFolder.appData', {
                ns: 'settings',
              })}
              column
              description={
                <>
                  {t('settings:dataFolder.appDataDesc', {
                    ns: 'settings',
                  })}
                  {unavailableDataFolder && (
                    <p role="alert" className="text-xs text-destructive mt-1">
                      {t('settings:dataFolder.unavailable', {
                        path: unavailableDataFolder,
                      })}
                    </p>
                  )}
                </>
              }
              actions={
                <>
                  <span className="flex h-8 min-w-0 flex-1 items-center gap-1 overflow-hidden rounded-lg border-[0.8px] border-border bg-muted py-0 pr-1 pl-2.5 pointer-coarse:h-11">
                    <span
                      data-testid="app-data-folder-path"
                      title={janDataFolder}
                      className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2"
                    >
                      {janDataFolder}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        janDataFolder && copyToClipboard(janDataFolder)
                      }
                      className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover-btn hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
                      title={
                        isCopied
                          ? t('settings:general.copied')
                          : t('settings:general.copyPath')
                      }
                      aria-label={
                        isCopied
                          ? t('settings:general.copied')
                          : t('settings:general.copyPath')
                      }
                    >
                      {isCopied ? (
                        <CopyCheck size={14} className="text-success" aria-hidden />
                      ) : (
                        <Copy size={14} aria-hidden />
                      )}
                    </button>
                  </span>
                  <Button
                    variant="outline"
                    className="pointer-coarse:h-11"
                    title={t('settings:dataFolder.appData')}
                    onClick={handleDataFolderChange}
                  >
                      <Icon name="x-folder" size={14} />
                      <span>{t('settings:general.changeLocation')}</span>
                  </Button>
                  {selectedNewPath && (
                    <ChangeDataFolderLocation
                      currentPath={janDataFolder || ''}
                      newPath={selectedNewPath}
                      onConfirm={confirmDataFolderChange}
                      open={isDialogOpen}
                      onOpenChange={(open) => {
                        setIsDialogOpen(open)
                        if (!open) {
                          setSelectedNewPath(null)
                        }
                      }}
                    >
                      <div />
                    </ChangeDataFolderLocation>
                  )}
                </>
              }
            />
            <CardItem
              anchor="settings-data-logs"
              title={t('settings:dataFolder.appLogs', {
                ns: 'settings',
              })}
              description={t('settings:dataFolder.appLogsDesc')}
              className="items-start"
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    className="pointer-coarse:h-11"
                    onClick={async () => {
                      if (janDataFolder) {
                        try {
                          const logsPath = await serviceHub.path().join(
                            janDataFolder,
                            'logs'
                          )
                          await serviceHub.opener().openPath(logsPath)
                        } catch (error) {
                          console.error(
                            'Failed to reveal logs folder:',
                            error
                          )
                        }
                      }
                    }}
                    title={t('settings:general.revealLogs')}
                  >
                    <Icon name="x-folder" size={14} />
                    <span>{openFileTitle()}</span>
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleOpenLogs}
                    title={t('settings:dataFolder.appLogs')}
                  >
                    <Icon name="sb-file" size={14} />
                    <span>{t('settings:general.openLogs')}</span>
                  </Button>
                  {IS_TAURI && (
                    <Button
                      variant="outline"
                      onClick={handleExportLogs}
                      title={t('settings:general.exportLogsDesc')}
                    >
                      <span>{t('settings:general.exportLogs')}</span>
                    </Button>
                  )}
                </div>
              }
            />
          </Card>
        )}

        {tab === 'storage' && IS_TAURI && <SettingsBackupCard />}

        {/* Import - Desktop only */}
        {tab === 'storage' && isPlatformTauri() && (
          <Card title={t('settings:memoryPage.import')}>
            <CardItem
              anchor="settings-data-migrate-from-jan"
              title={t('settings:general.migrateJan.title')}
              description={t('settings:general.migrateJan.desc')}
              actions={
                <Button
                  variant="outline"
                  data-testid="open-migration-assistant"
                  onClick={() => openMigrationAssistant()}
                >
                  {t('settings:general.migrateJan.open')}
                </Button>
              }
            />
            <CardItem
              anchor="settings-data-import-chatgpt"
              title={t('settings:general.importChatGpt')}
              description={t('settings:general.importChatGptDesc')}
              actions={
                <>
                  <input
                    ref={chatGptFileInput}
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    data-testid="import-chatgpt-file"
                    onChange={(e) => {
                      void handleImportChatGpt(e.target.files?.[0])
                      e.target.value = ''
                    }}
                  />
                  <Button
                    variant="outline"
                    onClick={() => chatGptFileInput.current?.click()}
                  >
                    {t('settings:general.importChatGptAction')}
                  </Button>
                </>
              }
            />
          </Card>
        )}

        {tab === 'cleanup' && (
          <BulkConversationsCard anchor="settings-data-bulk-conversations" />
        )}

        {/* Danger zone, last */}
        {tab === 'cleanup' && (
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
                  <Button variant="destructive">
                    {t('common:reset')}
                  </Button>
                </FactoryResetDialog>
              )
            }
          />
          </Card>
        )}

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
