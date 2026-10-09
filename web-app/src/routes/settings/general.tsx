import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'
import { useThreads } from '@/hooks/useThreads'
import { invoke } from '@tauri-apps/api/core'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { Switch } from '@/components/ui/switch'
import { BuildUpdateItem } from '@/containers/BuildUpdateItem'
import { Button } from '@/components/ui/button'
import { useMigrationAssistant } from '@/stores/migration-assistant-store'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useWebPreviewSettings } from '@/hooks/useWebPreviewSettings'
import { useEffect, useRef, useState } from 'react'
import ChangeDataFolderLocation from '@/containers/dialogs/ChangeDataFolderLocation'
import { FactoryResetDialog } from '@/containers/dialogs'
import { SettingsBackupCard } from '@/containers/SettingsBackupCard'
import type { FactoryResetOptions } from '@/services/app/types'
import { useServiceHub } from '@/hooks/useServiceHub'
import { Copy, CopyCheck } from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { toast } from 'sonner'
import { SystemEvent } from '@/types/events'
import { Input } from '@/components/ui/input'
import { useHardware } from '@/hooks/useHardware'
import LanguageSwitcher from '@/containers/LanguageSwitcher'
import ReplyLanguageSwitcher from '@/containers/ReplyLanguageSwitcher'
import FallbackModelsPicker from '@/containers/FallbackModelsPicker'
import { isRootDir } from '@/utils/path'
import {
  importConversations,
  parseChatGptExport,
} from '@/lib/chatgptImport'
const TOKEN_VALIDATION_TIMEOUT_MS = 10_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.general as any)({
  component: General,
})

function General() {
  const { t } = useTranslation()
  const openMigrationAssistant = useMigrationAssistant((s) => s.openAssistant)
  const {
    spellCheckChatInput,
    setSpellCheckChatInput,
    huggingfaceToken,
    setHuggingfaceToken,
  } = useGeneralSetting()
  const closeToTray = useGeneralSetting((s) => s.closeToTray)
  const setCloseToTray = useGeneralSetting((s) => s.setCloseToTray)
  const downloadLimitMBps = useGeneralSetting((s) => s.downloadLimitMBps)
  const setDownloadLimitMBps = useGeneralSetting((s) => s.setDownloadLimitMBps)
  const interceptLinks = useWebPreviewSettings((s) => s.interceptLinks)
  const setInterceptLinks = useWebPreviewSettings((s) => s.setInterceptLinks)
  const serviceHub = useServiceHub()
  const navigate = useNavigate()

  const openFileTitle = (): string => {
    if (IS_MACOS) {
      return t('settings:general.showInFinder')
    } else if (IS_WINDOWS) {
      return t('settings:general.showInFileExplorer')
    } else {
      return t('settings:general.openContainingFolder')
    }
  }
  const { pausePolling } = useHardware()
  const [janDataFolder, setJanDataFolder] = useState<string | undefined>()
  const [unavailableDataFolder, setUnavailableDataFolder] = useState<
    string | undefined
  >()
  const chatGptFileInput = useRef<HTMLInputElement>(null)
  const [isCopied, setIsCopied] = useState(false)
  const [selectedNewPath, setSelectedNewPath] = useState<string | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isValidatingToken, setIsValidatingToken] = useState(false)
  const [cliInstalled, setCliInstalled] = useState<boolean | null>(null)
  const [cliPath, setCliPath] = useState<string | null>(null)
  const [isCliLoading, setIsCliLoading] = useState(false)

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

  useEffect(() => {
    if (!IS_TAURI) return
    invoke<{ installed: boolean; path: string | null }>('check_jan_cli_installed')
      .then((s) => { setCliInstalled(s.installed); setCliPath(s.path) })
      .catch(() => setCliInstalled(false))
  }, [])

  const handleInstallCli = async () => {
    setIsCliLoading(true)
    try {
      const s = await invoke<{ installed: boolean; path: string | null }>('install_jan_cli')
      setCliInstalled(s.installed)
      setCliPath(s.path)
      toast.success(`Flint CLI installed to ${s.path}`)
    } catch (e) {
      toast.error('Install failed', { description: String(e) })
    } finally {
      setIsCliLoading(false)
    }
  }

  const handleUninstallCli = async () => {
    setIsCliLoading(true)
    try {
      await invoke('uninstall_jan_cli')
      setCliInstalled(false)
      setCliPath(null)
      toast.success('Flint CLI uninstalled')
    } catch (e) {
      toast.error('Uninstall failed', { description: String(e) })
    } finally {
      setIsCliLoading(false)
    }
  }

  const resetApp = async (options: FactoryResetOptions) => {
    if (isRootDir(janDataFolder ?? '/')) {
      toast.error(t('settings:general.couldNotResetRootDirectory'))
      return
    }
    pausePolling()
    await serviceHub.app().factoryReset(options)
  }

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
      const destination = await serviceHub.dialog().save({
        defaultPath: 'flint-logs-redacted.txt',
        filters: [{ name: 'Text', extensions: ['txt'] }],
      })
      if (!destination) return
      const path = await serviceHub.app().exportRedactedLogs(destination)
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
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader title={t('common:general')} />
      <SettingsPageBody
        title={t('common:general')}
        description={t('settings:pageDesc.general')}
        layout={[0, 1, 1, 1, 0, 0]}
      >

        {/* General */}
        <Card title={t('common:general')}>
          <CardItem
            title={t('settings:general.appVersion')}
            actions={
              <span className="font-mono text-xs text-muted-foreground">
                v{VERSION}
              </span>
            }
          />
          <BuildUpdateItem />
          <CardItem
            anchor="settings-general-language"
            title={t('common:language')}
            actions={<LanguageSwitcher />}
          />
          <CardItem
            title={t('settings:general.replyLanguage')}
            description={t('settings:general.replyLanguageDesc')}
            actions={<ReplyLanguageSwitcher />}
          />
          <CardItem
            title={t('settings:general.fallbackModels')}
            description={t('settings:general.fallbackModelsDesc')}
            actions={<FallbackModelsPicker />}
          />
          <CardItem
            title={t('onboarding:reopenGuide')}
            description={t('onboarding:reopenGuideDescription')}
            actions={
              <Button
                variant="outline"
                onClick={() => {
                  useOnboardingGuide
                    .getState()
                    .start(
                      useOnboardingGuide.getState().intent,
                      Object.keys(useThreads.getState().threads).length
                    )
                  navigate({ to: route.home })
                }}
              >
                {t('onboarding:reopenGuideAction')}
              </Button>
            }
          />
        </Card>

        {/* Data folder - Desktop only */}
        <Card title={t('common:dataFolder')}>
          <CardItem
            anchor="settings-general-migrate-from-jan"
            title="Migrate from JAN"
            description="Bring data from an existing JAN installation into Flint — copy, reuse in place, move, or start fresh."
            actions={
              <Button
                variant="outline"
                data-testid="open-migration-assistant"
                onClick={() => openMigrationAssistant()}
              >
                Open migration assistant
              </Button>
            }
          />
          <CardItem
            anchor="settings-general-import-chatgpt"
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
          <CardItem
            anchor="settings-general-data-folder"
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

        {IS_TAURI && <SettingsBackupCard />}

        {/* Advanced - Desktop only */}
        <Card title="Advanced">
          {IS_TAURI && (
            <CardItem
              title="Flint CLI"
              description={
                cliInstalled && cliPath
                  ? `Installed at ${cliPath} — use flint from your terminal to serve models.`
                  : 'Use flint from your terminal to serve models without opening the app.'
              }
              actions={
                cliInstalled ? (
                  <Button
                    variant="outline"
                    onClick={handleUninstallCli}
                    disabled={isCliLoading || cliInstalled === null}
                  >
                    {isCliLoading ? 'Uninstalling…' : 'Uninstall'}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={handleInstallCli}
                    disabled={isCliLoading || cliInstalled === null}
                  >
                    {isCliLoading ? 'Installing…' : 'Install'}
                  </Button>
                )
              }
            />
          )}
          <CardItem
            anchor="settings-general-factory-reset"
            title={t('settings:others.resetFactory', {
              ns: 'settings',
            })}
            description={t('settings:others.resetFactoryDesc', {
              ns: 'settings',
            })}
            actions={
              <FactoryResetDialog onReset={resetApp}>
                <Button variant="destructive">
                  {t('common:reset')}
                </Button>
              </FactoryResetDialog>
            }
          />
        </Card>

        {/* Other */}
        <Card title={t('common:others')}>
          {IS_TAURI && !IS_MACOS && (
            <CardItem
              anchor="settings-general-close-to-tray"
              title={t('settings:general.closeToTray')}
              description={t('settings:general.closeToTrayDesc')}
              actions={
                <Switch
                  checked={closeToTray}
                  onCheckedChange={(e) => setCloseToTray(e)}
                />
              }
            />
          )}
          {IS_TAURI && (
            <CardItem
              anchor="settings-general-download-limit"
              title={t('settings:general.downloadLimit')}
              description={t('settings:general.downloadLimitDesc')}
              actions={
                <Input
                  type="number"
                  min={0}
                  step={1}
                  className="w-24"
                  value={downloadLimitMBps}
                  onChange={(e) =>
                    setDownloadLimitMBps(Number(e.target.value))
                  }
                />
              }
            />
          )}
          <CardItem
            anchor="settings-general-web-preview"
            title={t('common:webPreview.interceptSetting')}
            description={t('common:webPreview.interceptSettingDesc')}
            actions={
              <Switch
                checked={interceptLinks}
                onCheckedChange={(e) => setInterceptLinks(e)}
              />
            }
          />
          <CardItem
            anchor="settings-general-spell-check"
            title={t('settings:others.spellCheck', {
              ns: 'settings',
            })}
            description={t('settings:others.spellCheckDesc', {
              ns: 'settings',
            })}
            actions={
              <Switch
                checked={spellCheckChatInput}
                onCheckedChange={(e) => setSpellCheckChatInput(e)}
              />
            }
          />
          <CardItem
            title={t('settings:general.huggingfaceToken', {
              ns: 'settings',
            })}
            description={t('settings:general.huggingfaceTokenDesc', {
              ns: 'settings',
            })}
            column
            actions={
              <div className="flex w-full min-w-0 items-center gap-2">
                <Input
                  id="hf-token"
                  className="min-w-0 flex-1 font-mono"
                  value={huggingfaceToken || ''}
                  onChange={(e) => setHuggingfaceToken(e.target.value)}
                  placeholder={'hf_xxx_xxx'}
                  required
                />
                <Button
                  variant="outline"
                  size='sm'
                  disabled={isValidatingToken}
                  onClick={async () => {
                    const token = (huggingfaceToken || '').trim()
                    if (!token) {
                      toast.error(
                        'Please enter a Hugging Face token to validate'
                      )
                      return
                    }
                    setIsValidatingToken(true)
                    const controller = new AbortController()
                    const timeoutId = setTimeout(
                      () => controller.abort(),
                      TOKEN_VALIDATION_TIMEOUT_MS
                    )
                    try {
                      const resp = await fetch(
                        'https://huggingface.co/api/whoami-v2',
                        {
                          headers: { Authorization: `Bearer ${token}` },
                          signal: controller.signal,
                        }
                      )
                      if (resp.ok) {
                        const data = await resp.json()
                        toast.success('Token is valid', {
                          description: data?.name
                            ? `Signed in as ${data.name}`
                            : 'Your Hugging Face token is valid.',
                        })
                      } else {
                        toast.error('Token invalid', {
                          description:
                            'The provided Hugging Face token is invalid. Please check your token and try again.',
                        })
                      }
                    } catch (e) {
                      const name = (e as { name?: string })?.name
                      if (name === 'AbortError') {
                        toast.error('Validation timed out', {
                          description:
                            'The validation request timed out. Please check your network connection and try again.',
                        })
                      } else {
                        toast.error('Validation failed', {
                          description:
                            'A network error occurred while validating the token. Please check your internet connection.',
                        })
                      }
                    } finally {
                      clearTimeout(timeoutId)
                      setIsValidatingToken(false)
                    }
                  }}
                >
                  Verify
                </Button>
              </div>
            }
          />
        </Card>


        {/* Credits */}
        <Card title={t('settings:general.credits')}>
          <CardItem
            align="start"
            description={
              <div className="text-muted-foreground -mt-2">
                <p>{t('settings:general.creditsDesc1')}</p>
                <p className="mt-2">{t('settings:general.creditsDesc2')}</p>
              </div>
            }
          />
        </Card>
      </SettingsPageBody>
    </div>
  )
}
