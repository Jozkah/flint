import { createFileRoute } from '@tanstack/react-router'
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
 * the current one carries the gradient pill (which glides between choices),
 * and choosing applies at once (persisted by the theme store).
 */
function ThemeSegmented() {
  const { t } = useTranslation()
  const activeTheme = useTheme((s) => s.activeTheme)
  const setTheme = useTheme((s) => s.setTheme)
  const options: { value: ThemeChoice; label: string }[] = [
    { value: 'light', label: t('common:light') },
    { value: 'dark', label: t('common:dark') },
    { value: 'auto', label: t('common:system') },
  ]
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === (activeTheme ?? 'auto'))
  )
  return (
    <div
      role="group"
      aria-label={t('settings:interface.theme')}
      data-testid="theme-segmented"
      className="relative flex w-[260px] max-w-full gap-2"
    >
      <span
        aria-hidden
        style={{ left: `calc((100% - 1rem) / 3 * ${index} + ${index} * 0.5rem)` }}
        className="pointer-events-none absolute top-0 h-7 w-[calc((100%-1rem)/3)] rounded-lg border border-primary bg-grad transition-[left] duration-300 ease-expo pointer-coarse:h-11"
      />
      {options.map(({ value, label }, i) => {
        const pressed = i === index
        return (
          <button
            key={value}
            type="button"
            aria-pressed={pressed}
            data-state={pressed ? 'on' : 'off'}
            data-testid={`theme-option-${value}`}
            onClick={() => setTheme(value)}
            className={cn(
              'relative z-10 inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border-[0.8px] px-2 text-xs font-medium transition-[color,background-color,border-color,transform] duration-200 ease-expo outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.97] pointer-coarse:h-11',
              pressed
                ? 'border-transparent bg-transparent text-on-grad'
                : 'border-border bg-card text-secondary-foreground hover:bg-hover-row'
            )}
          >
            <span className="truncate">{label}</span>
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
    reduceMotion,
    setReduceMotion,
  } = useInterfaceSettings()

  const theme = (
    <Card title={t('settings:appearance.themeGroup')}>
      <CardItem
        anchor="settings-appearance-theme"
        title={t('settings:appearance.themeLabel')}
        description={t('settings:appearance.themeHint')}
        actions={<ThemeSegmented />}
      />
    </Card>
  )

  const motion = (
    <Card title={t('settings:appearance.motionGroup')}>
      <CardItem
        anchor="settings-appearance-reduce-motion"
        title={t('settings:appearance.reduceMotion')}
        description={t('settings:appearance.reduceMotionDesc')}
        actions={
          <Switch
            aria-label={t('settings:appearance.reduceMotion')}
            data-testid="reduce-motion-switch"
            checked={Boolean(reduceMotion)}
            onCheckedChange={(v) => setReduceMotion?.(v)}
          />
        }
      />
    </Card>
  )

  const reading = (
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
          <Switch checked={showTokenSpeed} onCheckedChange={setShowTokenSpeed} />
        }
      />
    </Card>
  )

  const chatDisplay = (
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
          <span className="inline-flex flex-wrap items-baseline gap-1.5">
            <span>{t('settings:interface.renderHtmlArtifacts')}</span>
            <span className="text-[10.5px] font-normal text-subtle-foreground">
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
  )

  const reset = (
    <Card title={t('settings:appearance.resetGroup')}>
      <CardItem
        title={t('settings:interface.resetToDefault')}
        description={t('settings:interface.resetToDefaultDesc')}
        actions={
          <Button
            variant="destructive"
            className="pointer-coarse:h-11"
            onClick={() => {
              resetInterface()
              toast.success(t('settings:interface.resetInterfaceSuccess'), {
                id: 'reset-interface',
                description: t('settings:interface.resetInterfaceSuccessDesc'),
              })
            }}
          >
            {t('common:reset')}
          </Button>
        }
      />
    </Card>
  )

  return (
    <div className="flex h-full w-full flex-col">
      <SettingsPageHeader title={t('common:appearance')} />
      <SettingsPageBody
        title={t('common:appearance')}
        description={t('settings:pageDesc.appearance')}
        layout={[0, 1, 0, 1, 0, 0]}
      >
        {theme}
        <AccentSettings />
        {reading}
        {chatDisplay}
        {reset}
        {motion}
      </SettingsPageBody>
    </div>
  )
}
