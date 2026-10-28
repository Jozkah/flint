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
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FlintServerSettings } from '@/containers/FlintServerSettings'
import { RemoteRunnerCard } from '@/containers/RemoteRunnerCard'
import { StartupItems } from '@/containers/StartupItems'
import {
  isPlatformAndroid,
  isPlatformIOS,
  isPlatformTauri,
} from '@/lib/platform/utils'
import LanguageSwitcher from '@/containers/LanguageSwitcher'
import { isForeignBundledCli } from '@/utils/path'

 
export const Route = createFileRoute(route.settings.general)({
  component: General,
})

function General() {
  const { t } = useTranslation()
  const closeToTray = useGeneralSetting((s) => s.closeToTray)
  const setCloseToTray = useGeneralSetting((s) => s.setCloseToTray)
  const keepAwakeDuringRuns = useGeneralSetting((s) => s.keepAwakeDuringRuns)
  const loadSiteIcons = useGeneralSetting((s) => s.loadSiteIcons)
  const setLoadSiteIcons = useGeneralSetting((s) => s.setLoadSiteIcons)
  const setKeepAwakeDuringRuns = useGeneralSetting((s) => s.setKeepAwakeDuringRuns)
  const navigate = useNavigate()
  const [cliInstalled, setCliInstalled] = useState<boolean | null>(null)
  const [cliPath, setCliPath] = useState<string | null>(null)
  /** The CLI on PATH belongs to another copy of Flint, not this app. */
  const [cliForeign, setCliForeign] = useState(false)
  const [isCliLoading, setIsCliLoading] = useState(false)

  useEffect(() => {
    if (!IS_TAURI) return
    invoke<{ installed: boolean; path: string | null }>('check_jan_cli_installed')
      .then(async (s) => {
        setCliInstalled(s.installed)
        setCliPath(s.path)
        if (!s.installed || !s.path) return
        try {
          const { resourceDir } = await import('@tauri-apps/api/path')
          setCliForeign(
            typeof resourceDir === 'function' &&
              isForeignBundledCli(s.path, await resourceDir())
          )
        } catch {
          // Cannot tell whose it is: treat it as this app's, as before.
        }
      })
      .catch(() => setCliInstalled(false))
  }, [])

  const handleInstallCli = async () => {
    setIsCliLoading(true)
    try {
      const s = await invoke<{ installed: boolean; path: string | null }>('install_jan_cli')
      setCliInstalled(s.installed)
      setCliPath(s.path)
      setCliForeign(false)
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
              <span className="font-mono text-xs text-muted-foreground">
                v{VERSION}
              </span>
            }
          />
          {isPlatformTauri() && <BuildUpdateItem />}
          <CardItem
            anchor="settings-general-language"
            title={t('common:language')}
            actions={<LanguageSwitcher />}
          />
          <CardItem
            anchor="settings-general-site-icons"
            title={t('settings:general.siteIcons')}
            description={t('settings:general.siteIconsDesc')}
            actions={
              <Switch
                checked={loadSiteIcons}
                aria-label={t('settings:general.siteIcons')}
                onCheckedChange={(e) => setLoadSiteIcons(e)}
              />
            }
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

        {/* Startup and tray - Desktop only */}
        {IS_TAURI && !isPlatformAndroid() && !isPlatformIOS() && (
          <Card
            title={t('settings:general.startupGroup', {
              defaultValue: 'Startup and tray',
            })}
          >
            <StartupItems />
            {IS_WINDOWS && (
              <CardItem
                anchor="settings-general-keep-awake"
                title={t('settings:general.keepAwake')}
                description={t('settings:general.keepAwakeDesc')}
                actions={
                  <Switch
                    checked={keepAwakeDuringRuns}
                    aria-label={t('settings:general.keepAwake')}
                    onCheckedChange={(e) => setKeepAwakeDuringRuns(e)}
                  />
                }
              />
            )}
            {!IS_MACOS && (
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
          </Card>
        )}

        {/* Command line - Desktop only */}
        {IS_TAURI && (
          <Card
            title={t('settings:general.cliGroup', {
              defaultValue: 'Command line',
            })}
          >
            <CardItem
              title="Flint CLI"
              description={
                cliInstalled && cliPath
                  ? t(
                      cliForeign
                        ? 'settings:general.cli.foreignDesc'
                        : 'settings:general.cli.installedDesc',
                      { path: cliPath }
                    )
                  : t('settings:general.cli.desc')
              }
              actions={
                cliInstalled && !cliForeign ? (
                  <Button
                    variant="outline"
                    onClick={handleUninstallCli}
                    disabled={isCliLoading || cliInstalled === null}
                  >
                    {isCliLoading
                      ? t('settings:general.cli.uninstalling')
                      : t('settings:general.cli.uninstall')}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={handleInstallCli}
                    disabled={isCliLoading || cliInstalled === null}
                  >
                    {isCliLoading
                      ? t('settings:general.cli.installing')
                      : t('settings:general.cli.install')}
                  </Button>
                )
              }
            />
          </Card>
        )}

        {/* The phone builds have no agent of their own: they open a Flint server. */}
        {(isPlatformAndroid() || isPlatformIOS()) && <FlintServerSettings />}
        {/* A page served by flint serve: can this server run agents? */}
        <RemoteRunnerCard />

      </SettingsPageBody>
    </div>
  )
}
