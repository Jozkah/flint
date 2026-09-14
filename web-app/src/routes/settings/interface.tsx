import { createFileRoute } from '@tanstack/react-router'
import { Monitor, Moon, Sun } from 'lucide-react'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { FontSizeSwitcher } from '@/containers/FontSizeSwitcher'
import { AccentSettings } from '@/containers/AccentSettings'
import { NotificationPositionSwitcher } from '@/containers/NotificationPositionSwitcher'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useTheme } from '@/hooks/useTheme'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.interface as any)({
  component: InterfaceSettings,
})

type ThemeChoice = 'auto' | 'light' | 'dark'

/**
 * Light / Dark / System as one segmented control: every choice is visible,
 * the current one is pressed, and choosing applies at once (persisted by the
 * theme store).
 */
function ThemeSegmented() {
  const { t } = useTranslation()
  const activeTheme = useTheme((s) => s.activeTheme)
  const setTheme = useTheme((s) => s.setTheme)
  const options: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
    { value: 'light', label: t('common:light'), icon: Sun },
    { value: 'dark', label: t('common:dark'), icon: Moon },
    { value: 'auto', label: t('common:system'), icon: Monitor },
  ]
  return (
    <div
      role="group"
      aria-label={t('settings:interface.theme')}
      data-testid="theme-segmented"
      className="inline-grid grid-flow-col auto-cols-fr gap-0.5 rounded-md bg-sunken p-0.5"
    >
      {options.map(({ value, label, icon: Icon }) => {
        const pressed = (activeTheme ?? 'auto') === value
        return (
          <button
            key={value}
            type="button"
            aria-pressed={pressed}
            data-testid={`theme-option-${value}`}
            onClick={() => setTheme(value)}
            className={cn(
              'inline-flex h-7 pointer-coarse:h-11 items-center justify-center gap-1.5 rounded-[5px] px-3 text-sm font-medium text-ink-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring',
              pressed && 'bg-card text-foreground ring-1 ring-border'
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {label}
          </button>
        )
      })}
    </div>
  )
}

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
      <SettingsPageHeader title={t('common:appearance')} />
      <SettingsPageBody
        title={t('common:appearance')}
        description={t('settings:pageDesc.appearance')}
      >
        <Card title={t('settings:appearance.themeGroup')}>
          <CardItem
            anchor="settings-appearance-theme"
            title={t('settings:appearance.themeLabel')}
            description={t('settings:appearance.themeHint')}
            className="flex-col sm:flex-row"
            actions={<ThemeSegmented />}
          />
        </Card>

        <AccentSettings />

        <Card title={t('settings:appearance.readingGroup')}>
          <CardItem
            anchor="settings-appearance-font-size"
            title={t('settings:interface.fontSize')}
            description={t('settings:interface.fontSizeDesc')}
            actions={<FontSizeSwitcher />}
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
        </Card>

        <Card title={t('settings:appearance.behaviourGroup')}>
          <CardItem
            anchor="settings-appearance-notification-position"
            title={t('settings:interface.notificationPosition')}
            description={t('settings:interface.notificationPositionDesc')}
            actions={<NotificationPositionSwitcher />}
          />
          <CardItem
            anchor="settings-appearance-html-artifacts"
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>{t('settings:interface.renderHtmlArtifacts')}</span>
                <span className="rounded-md bg-warning-tint px-1.5 py-0.5 text-xs font-medium text-warning">
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
        </Card>

        <Card title={t('settings:appearance.resetGroup')}>
          <CardItem
            title={t('settings:interface.resetToDefault')}
            description={t('settings:interface.resetToDefaultDesc')}
            actions={
              <Button
                variant="destructive"
                size="sm"
                className="pointer-coarse:h-11"
                onClick={() => {
                  resetInterface()
                  toast.success(t('settings:interface.resetInterfaceSuccess'), {
                    id: 'reset-interface',
                    description: t(
                      'settings:interface.resetInterfaceSuccessDesc'
                    ),
                  })
                }}
              >
                {t('common:reset')}
              </Button>
            }
          />
        </Card>
      </SettingsPageBody>
    </div>
  )
}
