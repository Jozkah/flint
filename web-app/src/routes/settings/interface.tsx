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
import { SidebarItemsPicker } from '@/containers/SidebarItemsPicker'
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
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { TRANSCRIPT_VIEWS } from '@/lib/transcriptView'
import { toast } from 'sonner'
import { switchTheme } from '@/lib/themeTransition'
import {
  PERFORMANCE_MODES,
  resolvePerfReduced,
  usePerfDetection,
  type PerformanceMode,
} from '@/lib/perfMode'

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
      className="relative grid w-max max-w-full min-w-[260px] grid-cols-3 gap-2"
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
            onClick={(e) => {
              if (!pressed) switchTheme(e.currentTarget, value, setTheme)
            }}
            className={cn(
              'relative z-10 inline-flex h-7 items-center justify-center gap-1.5 rounded-lg border-[0.8px] px-2 text-xs font-medium transition-[color,background-color,border-color,transform] duration-200 ease-expo outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.97] pointer-coarse:h-11',
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
    renderUserMarkdown,
    setRenderUserMarkdown,
    renderHtmlArtifacts,
    setRenderHtmlArtifacts,
    wrapCodeLines,
    setWrapCodeLines,
    showInlineCitations,
    setShowInlineCitations,
    autoGenerateTitle,
    setAutoGenerateTitle,
    reduceMotion,
    setReduceMotion,
    increaseContrast,
    setIncreaseContrast,
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
        classNameWrapperAction="sm:max-w-full"
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
      <PerformanceModeSetting />
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
        anchor="settings-appearance-increase-contrast"
        title={t('settings:appearance.increaseContrast')}
        description={t('settings:appearance.increaseContrastDesc')}
        actions={
          <Switch
            aria-label={t('settings:appearance.increaseContrast')}
            data-testid="increase-contrast-switch"
            checked={Boolean(increaseContrast)}
            onCheckedChange={(v) => setIncreaseContrast?.(v)}
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
        anchor="settings-appearance-user-markdown"
        title={t('settings:interface.renderUserMarkdown')}
        description={t('settings:interface.renderUserMarkdownDesc')}
        actions={
          <Switch
            aria-label={t('settings:interface.renderUserMarkdown')}
            data-testid="render-user-markdown-switch"
            checked={renderUserMarkdown}
            onCheckedChange={setRenderUserMarkdown}
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

  const sidebarItems = (
    <Card
      title={t('settings:sidebarItems.title')}
      description={t('settings:sidebarItems.description')}
      anchor="settings-appearance-sidebar-items"
    >
      <SidebarItemsPicker />
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
        anchor="settings-appearance-wrap-code-lines"
        title={t('settings:interface.wrapCodeLines')}
        description={t('settings:interface.wrapCodeLinesDesc')}
        actions={
          <Switch
            aria-label={t('settings:interface.wrapCodeLines')}
            checked={wrapCodeLines}
            onCheckedChange={setWrapCodeLines}
          />
        }
      />
      <CardItem
        anchor="settings-appearance-inline-citations"
        title={t('settings:interface.inlineCitations')}
        description={t('settings:interface.inlineCitationsDesc')}
        actions={
          <Switch
            aria-label={t('settings:interface.inlineCitations')}
            checked={showInlineCitations}
            onCheckedChange={setShowInlineCitations}
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
        // stretch. The Sidebar items card (2) is wide and holds a long list,
        // so it spans both columns between two balanced rows: theme and
        // reading against accent and transcript view above it; chat display
        // against reset, motion and sounds below.
        layout={[0, 1, 0, 1, 2, 0, 1, 1, 1]}
      >
        {theme}
        <AccentSettings />
        {reading}
        {transcript}
        {sidebarItems}
        {chatDisplay}
        {reset}
        {motion}
        <CompletionSoundSettings />
      </SettingsPageBody>
    </div>
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
  approval: 'settings:appearance.completionSoundApproval',
}

/** The value a radio-group key moves to (arrows wrap, Home / End jump). */
function stepRadio<T>(values: readonly T[], current: T, key: string): T | undefined {
  const i = Math.max(0, values.indexOf(current))
  const n = values.length
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return values[(i + 1) % n]
    case 'ArrowLeft':
    case 'ArrowUp':
      return values[(i - 1 + n) % n]
    case 'Home':
      return values[0]
    case 'End':
      return values[n - 1]
    default:
      return undefined
  }
}

const PERF_LABEL: Record<PerformanceMode, string> = {
  auto: 'settings:appearance.performanceModeAuto',
  reduced: 'settings:appearance.performanceModeReduced',
  full: 'settings:appearance.performanceModeFull',
}

/** Settings › Appearance › Motion: Performance mode, with what Auto found. */
export function PerformanceModeSetting() {
  const { t } = useTranslation()
  const mode = useInterfaceSettings((s) => s.performanceMode)
  const setMode = useInterfaceSettings((s) => s.setPerformanceMode)
  const detection = usePerfDetection((s) => s.detection)
  const reduced = resolvePerfReduced(mode, detection)
  const why =
    mode === 'reduced'
      ? t('settings:appearance.perfReasonChosen')
      : detection.reason === 'cores'
        ? t('settings:appearance.perfReasonCores', { n: detection.cores })
        : detection.reason === 'memory'
          ? t('settings:appearance.perfReasonMemory', { n: detection.memoryGb })
          : detection.reason === 'frames'
            ? t('settings:appearance.perfReasonFrames')
            : detection.reason === 'motion'
              ? t('settings:appearance.perfReasonMotion')
              : t('settings:appearance.perfReasonData')
  const current = reduced
    ? t('settings:appearance.performanceModeNowReduced', { why })
    : t('settings:appearance.performanceModeNowFull')
  return (
    <CardItem
      column
      anchor="settings-appearance-performance-mode"
      title={t('settings:appearance.performanceMode')}
      description={
        <>
          {t('settings:appearance.performanceModeDesc')}{' '}
          <span data-testid="performance-mode-current">{current}</span>
        </>
      }
      actions={
        // Radix radio group: one tab stop (roving tabindex) and arrow focus.
        // Radix only selects on arrow focus while the key is still down, so the
        // keys also pick the mode here; Home / End jump to the first / last.
        <RadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as PerformanceMode)}
          onKeyDown={(e) => {
            const next = stepRadio(PERFORMANCE_MODES, mode, e.key)
            if (next !== undefined && next !== mode) setMode(next)
          }}
          orientation="horizontal"
          loop
          aria-label={t('settings:appearance.performanceMode')}
          data-testid="performance-mode"
          className="inline-flex flex-wrap gap-0 rounded-md border border-border p-0.5"
        >
          {PERFORMANCE_MODES.map((m) => (
            <RadioGroupPrimitive.Item
              key={m}
              value={m}
              data-mode={m}
              className={cn(
                'rounded px-2.5 py-1 text-xs outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:py-2.5',
                mode === m ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground'
              )}
            >
              {t(PERF_LABEL[m])}
            </RadioGroupPrimitive.Item>
          ))}
        </RadioGroup>
      }
    />
  )
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
            // Two even columns: four options never leave one alone on a
            // ragged second line.
            className="grid w-full max-w-md grid-cols-2 gap-0.5 rounded-md border border-border p-0.5"
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
                  'min-w-0 rounded px-2.5 py-1 text-xs leading-tight pointer-coarse:py-2.5',
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
