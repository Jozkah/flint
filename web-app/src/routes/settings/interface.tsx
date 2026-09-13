import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { SettingsPageHeader } from '@/containers/SettingsPageHeader'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ThemeSwitcher } from '@/containers/ThemeSwitcher'
import { FontSizeSwitcher } from '@/containers/FontSizeSwitcher'
import { AccentSettings } from '@/containers/AccentSettings'
import { NotificationPositionSwitcher } from '@/containers/NotificationPositionSwitcher'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.interface as any)({
  component: InterfaceSettings,
})

function InterfaceSettings() {
  const { t } = useTranslation()
  const {
    resetInterface,
    showTokenSpeed,
    setShowTokenSpeed,
    coloredUserBubble,
    setColoredUserBubble,
    renderHtmlArtifacts,
    setRenderHtmlArtifacts,
    autoGenerateTitle,
    setAutoGenerateTitle,
  } = useInterfaceSettings()

  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader />
      <div className="flex h-[calc(100%-var(--ctx-h))] min-h-0">
        <div className="w-full min-w-0 overflow-x-hidden overflow-y-auto px-3 py-4 md:px-6 md:py-6">
          <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4">
            {/* Interface */}
            <Card title={t('settings:interface.title')}>
              <CardItem
                anchor="settings-appearance-theme"
                title={t('settings:interface.theme')}
                description={t('settings:interface.themeDesc')}
                actions={<ThemeSwitcher />}
              />
              <CardItem
                anchor="settings-appearance-font-size"
                title={t('settings:interface.fontSize')}
                description={t('settings:interface.fontSizeDesc')}
                actions={<FontSizeSwitcher />}
              />
              <CardItem
                anchor="settings-appearance-accent"
                title={t('settings:accent.title')}
                description={t('settings:accent.description')}
                column
                className="flex-col items-start gap-y-3"
                actions={<AccentSettings />}
              />
              <CardItem
                anchor="settings-appearance-notification-position"
                title={t('settings:interface.notificationPosition')}
                description={t('settings:interface.notificationPositionDesc')}
                actions={<NotificationPositionSwitcher />}
              />
              <CardItem
                anchor="settings-appearance-token-speed"
                title={t('settings:interface.showTokenSpeed')}
                description={t('settings:interface.showTokenSpeedDesc')}
                actions={
                  <Switch
                    checked={showTokenSpeed}
                    onCheckedChange={setShowTokenSpeed}
                  />
                }
              />
              <CardItem
                title={t('settings:interface.coloredUserBubble')}
                description={t('settings:interface.coloredUserBubbleDesc')}
                actions={
                  <Switch
                    checked={coloredUserBubble}
                    onCheckedChange={setColoredUserBubble}
                  />
                }
              />
              <CardItem
                anchor="settings-appearance-html-artifacts"
                title={
                  <span className="inline-flex items-center gap-2">
                    <span>{t('settings:interface.renderHtmlArtifacts')}</span>
                    <span className="rounded-full bg-warning-tint px-2 py-0.5 text-xs font-normal text-warning">
                      {t('common:experimental')}
                    </span>
                  </span>
                }
                description={t('settings:interface.renderHtmlArtifactsDesc')}
                actions={
                  <Switch
                    checked={renderHtmlArtifacts}
                    onCheckedChange={setRenderHtmlArtifacts}
                  />
                }
              />
              <CardItem
                anchor="settings-appearance-auto-title"
                title={t('settings:interface.autoGenerateTitle')}
                description={t('settings:interface.autoGenerateTitleDesc')}
                actions={
                  <Switch
                    checked={autoGenerateTitle}
                    onCheckedChange={setAutoGenerateTitle}
                  />
                }
              />
              <CardItem
                title={t('settings:interface.resetToDefault')}
                description={t('settings:interface.resetToDefaultDesc')}
                actions={
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      resetInterface()
                      toast.success(
                        t('settings:interface.resetInterfaceSuccess'),
                        {
                          id: 'reset-interface',
                          description: t(
                            'settings:interface.resetInterfaceSuccessDesc'
                          ),
                        }
                      )
                    }}
                  >
                    {t('common:reset')}
                  </Button>
                }
              />
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
