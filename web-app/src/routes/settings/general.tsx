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
import { Button } from '@/components/ui/button'
import { useMigrationAssistant } from '@/stores/migration-assistant-store'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useEffect, useState } from 'react'
import ChangeDataFolderLocation from '@/containers/dialogs/ChangeDataFolderLocation'
import { FactoryResetDialog } from '@/containers/dialogs'
import type { FactoryResetOptions } from '@/services/app/types'
import { useServiceHub } from '@/hooks/useServiceHub'
import { Copy, CopyCheck, Folder, ScrollText } from 'lucide-react'
import { toast } from 'sonner'
import { SystemEvent } from '@/types/events'
import { Input } from '@/components/ui/input'
import { useHardware } from '@/hooks/useHardware'
import LanguageSwitcher from '@/containers/LanguageSwitcher'
import { isRootDir } from '@/utils/path'
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
      setSelectedNewPath(selectedPath as string)
      setIsDialogOpen(true)
    }
  }

  const confirmDataFolderChange = async () => {
    if (selectedNewPath) {
      try {
        await serviceHub.models().stopAllModels()
        serviceHub.events().emit(SystemEvent.KILL_SIDECAR)
        setTimeout(async () => {
          try {
            // Prevent relocating to root directory (e.g., C:\ or D:\ on Windows, / on Unix)
            if (isRootDir(selectedNewPath))
              throw new Error(t('settings:general.couldNotRelocateToRoot'))
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
      >

        {/* General */}
        <Card title={t('common:general')}>
          <CardItem
            title={t('settings:general.appVersion')}
            actions={
              <span className="text-foreground font-medium">
                v{VERSION}
              </span>
            }
          />
          <CardItem
            anchor="settings-general-language"
            title={t('common:language')}
            actions={<LanguageSwitcher />}
          />
          <CardItem
            title={t('onboarding:reopenGuide')}
            description={t('onboarding:reopenGuideDescription')}
            actions={
              <Button
                variant="outline"
                size="sm"
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
                size="sm"
                data-testid="open-migration-assistant"
                onClick={() => openMigrationAssistant()}
              >
                Open migration assistant
              </Button>
            }
          />
          <CardItem
            anchor="settings-general-data-folder"
            title={t('settings:dataFolder.appData', {
              ns: 'settings',
            })}
            align="start"
            className="items-start"
            description={
              <>
                <span>
                  {t('settings:dataFolder.appDataDesc', {
                    ns: 'settings',
                  })}
                  &nbsp;
                </span>
                <div className="mt-1 flex min-w-0 items-center gap-2">
                  <div className="min-w-0 max-w-100 rounded-sm bg-sunken px-1.5 py-0.5">
                    <span
                      title={janDataFolder}
                      className="line-clamp-1 break-all font-mono text-xs text-ink-2"
                    >
                      {janDataFolder}
                    </span>
                  </div>
                  <button
                    onClick={() =>
                      janDataFolder && copyToClipboard(janDataFolder)
                    }
                    className="flex shrink-0 cursor-pointer items-center justify-center rounded-sm p-1 transition-colors hover:bg-sunken focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                    title={
                      isCopied
                        ? t('settings:general.copied')
                        : t('settings:general.copyPath')
                    }
                  >
                    {isCopied ? (
                      <div className="flex items-center gap-1">
                        <CopyCheck size={14} className="text-success" aria-hidden />
                        <span className="text-xs leading-0">
                          {t('settings:general.copied')}
                        </span>
                      </div>
                    ) : (
                      <Copy
                        size={14}
                        className="text-muted-foreground"
                        aria-hidden
                      />
                    )}
                  </button>
                </div>
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
                <Button
                  variant="outline"
                  size="sm"
                  title={t('settings:dataFolder.appData')}
                  onClick={handleDataFolderChange}
                >
                    <Folder
                      size={12}
                      className="text-muted-foreground"
                    />
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
                  size="sm"
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
                  <Folder
                    size={12}
                    className="text-muted-foreground"
                  />
                  <span>{openFileTitle()}</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleOpenLogs}
                  title={t('settings:dataFolder.appLogs')}
                >
                  <ScrollText size={12} className="text-muted-foreground" aria-hidden />
                  <span>{t('settings:general.openLogs')}</span>
                </Button>
              </div>
            }
          />
        </Card>

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
                    size="sm"
                    onClick={handleUninstallCli}
                    disabled={isCliLoading || cliInstalled === null}
                  >
                    {isCliLoading ? 'Uninstalling…' : 'Uninstall'}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
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
                <Button variant="destructive" size="sm">
                  {t('common:reset')}
                </Button>
              </FactoryResetDialog>
            }
          />
        </Card>

        {/* Other */}
        <Card title={t('common:others')}>
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
            actions={
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                <Input
                  id="hf-token"
                  className="font-mono sm:w-56"
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
