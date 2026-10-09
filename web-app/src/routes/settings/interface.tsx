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
import {
  COMPLETION_SOUNDS,
  useInterfaceSettings,
  type CompletionSound,
} from '@/hooks/useInterfaceSettings'
import { Slider } from '@/components/ui/slider'
import { playCompletionSound } from '@/lib/completionSound'
import { useTheme } from '@/hooks/useTheme'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { TRANSCRIPT_VIEWS } from '@/lib/transcriptView'
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
    showComposerRailButtons,
    setShowComposerRailButtons,
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

  const transcript = (
    <Card title={t('settings:interface.transcriptView')}>
      <CardItem
        anchor="settings-appearance-transcript-view"
        title={t('settings:interface.transcriptView')}
        description={t('settings:interface.transcriptViewDesc')}
      />
      <TranscriptViewPicker />
    </Card>
  )

  const sidebar = (
    <Card title={t('settings:interface.sidebarLayout')}>
      <CardItem
        anchor="settings-appearance-sidebar-layout"
        title={t('settings:interface.sidebarLayout')}
        description={t('settings:interface.sidebarLayoutDesc')}
      />
      <SidebarLayoutPicker />
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
        anchor="settings-appearance-composer-rail-buttons"
        title={t('settings:interface.composerRailButtons')}
        description={t('settings:interface.composerRailButtonsDesc')}
        actions={
          <Switch
            aria-label={t('settings:interface.composerRailButtons')}
            data-testid="composer-rail-buttons-switch"
            checked={Boolean(showComposerRailButtons)}
            onCheckedChange={(v) => setShowComposerRailButtons?.(v)}
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
        // Two columns of about equal height, so neither ends in a long empty
        // stretch: the everyday settings on the left with Reset last, the
        // tall pickers (accent, transcript view) and Sounds on the right.
        layout={[0, 1, 0, 1, 1, 0, 1, 0, 0]}
      >
        {theme}
        <AccentSettings />
        {reading}
        {transcript}
        {sidebar}
        {chatDisplay}
        <CompletionSoundSettings />
        {motion}
        {reset}
      </SettingsPageBody>
    </div>
  )
}

/** Trimmed or extended sidebar: two radios, each with its summary. */
function SidebarLayoutPicker() {
  const { t } = useTranslation()
  const value = useInterfaceSettings((s) => s.sidebarLayout)
  const setValue = useInterfaceSettings((s) => s.setSidebarLayout)
  return (
    <RadioGroup
      value={value}
      onValueChange={(v) => setValue(v as typeof value)}
      aria-label={t('settings:interface.sidebarLayout')}
      data-testid="sidebar-layout-picker"
      className="gap-2 pb-2"
    >
      {(['trimmed', 'extended'] as const).map((mode) => {
        const id = `sidebar-layout-${mode}`
        return (
          <label
            key={mode}
            htmlFor={id}
            className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1.5"
          >
            <RadioGroupItem
              id={id}
              value={mode}
              aria-describedby={`${id}-desc`}
              className="mt-0.5"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">
                {t(`settings:interface.sidebarLayout_${mode}`)}
              </span>
              <span id={`${id}-desc`} className="text-xs text-muted-foreground">
                {t(`settings:interface.sidebarLayout_${mode}Desc`)}
              </span>
            </span>
          </label>
        )
      })}
    </RadioGroup>
  )
}

/** The Transcript view setting: one radio per mode, each with its summary. */
function TranscriptViewPicker() {
  const { t } = useTranslation()
  const value = useInterfaceSettings((s) => s.transcriptView)
  const setValue = useInterfaceSettings((s) => s.setTranscriptView)
  const label = {
    normal: t('settings:interface.transcriptViewNormal'),
    thinking: t('settings:interface.transcriptViewThinking'),
    verbose: t('settings:interface.transcriptViewVerbose'),
  }
  const desc = {
    normal: t('settings:interface.transcriptViewNormalDesc'),
    thinking: t('settings:interface.transcriptViewThinkingDesc'),
    verbose: t('settings:interface.transcriptViewVerboseDesc'),
  }
  return (
    <RadioGroup
      value={value}
      onValueChange={(v) => setValue(v as typeof value)}
      aria-label={t('settings:interface.transcriptView')}
      data-testid="transcript-view-picker"
      className="gap-2 pb-2"
    >
      {TRANSCRIPT_VIEWS.map((mode) => {
        const id = `transcript-view-${mode}`
        return (
          <label
            key={mode}
            htmlFor={id}
            className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1.5"
          >
            <RadioGroupItem
              id={id}
              value={mode}
              aria-describedby={`${id}-desc`}
              className="mt-0.5"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">
                {label[mode]}
              </span>
              <span id={`${id}-desc`} className="text-xs text-muted-foreground">
                {desc[mode]}
              </span>
            </span>
          </label>
        )
      })}
    </RadioGroup>
  )
}

const LABEL: Record<CompletionSound, string> = {
  off: 'settings:appearance.completionSoundOff',
  background: 'settings:appearance.completionSoundBackground',
  always: 'settings:appearance.completionSoundAlways',
}

/** Settings › Appearance › Sounds: when a finished answer plays a sound. */
function CompletionSoundSettings() {
  const { t } = useTranslation()
  const mode = useInterfaceSettings((s) => s.completionSound)
  const volume = useInterfaceSettings((s) => s.completionSoundVolume)
  const setMode = useInterfaceSettings((s) => s.setCompletionSound)
  const setVolume = useInterfaceSettings((s) => s.setCompletionSoundVolume)

  return (
    <Card title={t('settings:appearance.soundGroup')}>
      <CardItem
        column
        anchor="settings-appearance-completion-sound"
        title={t('settings:appearance.completionSound')}
        description={t('settings:appearance.completionSoundDesc')}
        actions={
          <div
            role="radiogroup"
            aria-label={t('settings:appearance.completionSound')}
            data-testid="completion-sound-mode"
            className="inline-flex flex-wrap rounded-md border border-border p-0.5"
          >
            {COMPLETION_SOUNDS.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                data-mode={m}
                onClick={() => setMode(m)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs pointer-coarse:py-2.5',
                  mode === m ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground'
                )}
              >
                {t(LABEL[m])}
              </button>
            ))}
          </div>
        }
      />
      <CardItem
        anchor="settings-appearance-completion-sound-volume"
        title={t('settings:appearance.completionSoundVolume')}
        actions={
          <div className="flex items-center gap-3">
            <Slider
              aria-label={t('settings:appearance.completionSoundVolume')}
              data-testid="completion-sound-volume"
              className="w-32"
              min={0}
              max={100}
              step={5}
              value={[Math.round(volume * 100)]}
              onValueChange={([v]) => setVolume(v / 100)}
            />
            <Button
              size="sm"
              variant="outline"
              data-testid="completion-sound-preview"
              onClick={() => playCompletionSound(volume, { force: true })}
            >
              {t('settings:appearance.completionSoundPreview')}
            </Button>
          </div>
        }
      />
    </Card>
  )
}
