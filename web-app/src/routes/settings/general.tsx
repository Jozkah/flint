import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'
import { useThreads } from '@/hooks/useThreads'
import { invoke } from '@tauri-apps/api/core'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useEffect, useState } from 'react'
import ChangeDataFolderLocation from '@/containers/dialogs/ChangeDataFolderLocation'
import { FactoryResetDialog } from '@/containers/dialogs'
import type { FactoryResetOptions } from '@/services/app/types'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  IconFolder,
  IconLogs,
  IconCopy,
  IconCopyCheck,
} from '@tabler/icons-react'
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
      toast.success(`Jan CLI installed to ${s.path}`)
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
      toast.success('Jan CLI uninstalled')
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
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className='font-medium text-base font-studio'>{t('common:settings')}</span>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-var(--ctx-h))]">
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">

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
                anchor="settings-general-data-folder"
                title={t('settings:dataFolder.appData', {
                  ns: 'settings',
                })}
                align="start"
                className="items-start flex-row gap-2"
                description={
                  <>
                    <span>
                      {t('settings:dataFolder.appDataDesc', {
                        ns: 'settings',
                      })}
                      &nbsp;
                    </span>
                    <div className="flex items-center gap-2 mt-1">
                      <div className="max-w-100 bg-secondary rounded-sm px-1 py-0.5">
                        <span
                          title={janDataFolder}
                          className="text-xs line-clamp-1 break-all"
                        >
                          {janDataFolder}
                        </span>
                      </div>
                      <button
                        onClick={() =>
                          janDataFolder && copyToClipboard(janDataFolder)
                        }
                        className="cursor-pointer flex items-center justify-center rounded-sm bg-secondary transition-all duration-200 ease-in-out p-1"
                        title={
                          isCopied
                            ? t('settings:general.copied')
                            : t('settings:general.copyPath')
                        }
                      >
                        {isCopied ? (
                          <div className="flex items-center gap-1">
                            <IconCopyCheck size={14} className="text-green-500 dark:text-green-600" />
                            <span className="text-xs leading-0">
                              {t('settings:general.copied')}
                            </span>
                          </div>
                        ) : (
                          <IconCopy
                            size={14}
                            className="text-muted-foreground"
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
                        <IconFolder
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
                className="items-start flex-row gap-y-2"
                actions={
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="p-0"
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
                      <IconFolder
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
                      <IconLogs size={12} className="text-muted-foreground" />
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
                  title="Jan CLI"
                  description={
                    cliInstalled && cliPath
                      ? `Installed at ${cliPath} — use jan from your terminal to serve models.`
                      : 'Use jan from your terminal to serve models without opening the app.'
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
                  <div className="flex items-center gap-2">
                    <Input
                      id="hf-token"
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
          </div>
        </div>
      </div>
    </div>
  )
}
