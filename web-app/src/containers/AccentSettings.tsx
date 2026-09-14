import { useEffect, useId, useRef, useState } from 'react'
import { CheckIcon, InfoIcon, OctagonAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { cn } from '@/lib/utils'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useTheme } from '@/hooks/useTheme'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  accentBase,
  contrastRatio,
  deriveAccentTokens,
  normalizeHex,
  readHexInput,
  sameSelection,
  semanticProximity,
} from '@/lib/accent'

/**
 * Settings > Appearance > Accent colour, as its own settings group. Presets as
 * swatch radios (the selected one gets a neutral ring, never the accent), a
 * native colour picker and a hex field that validates as the user types. A
 * valid value applies immediately and is saved; an invalid one is explained
 * and leaves the accent unchanged. A sample row shows the accent's roles next
 * to success, error and diff colours, so their meanings stay visibly apart.
 */
export function AccentSettings() {
  const { t } = useTranslation()
  const accent = useInterfaceSettings((s) => s.accent)
  const setAccent = useInterfaceSettings((s) => s.setAccent)
  const previewAccent = useInterfaceSettings((s) => s.previewAccent)
  const resetAccent = useInterfaceSettings((s) => s.resetAccent)
  const isDark = useTheme((s) => s.isDark)
  const theme = isDark ? 'dark' : 'light'
  const base = accentBase(accent, theme)
  const tokens = deriveAccentTokens(base.hex, theme)
  const onFillRatio = contrastRatio(base.hex, tokens.onFill)
  const isCustom = 'custom' in accent
  const isDefault = sameSelection(accent, DEFAULT_ACCENT)
  const proximity = semanticProximity(base.hex)
  const defaultPresetId =
    'preset' in DEFAULT_ACCENT ? DEFAULT_ACCENT.preset : undefined
  const defaultName =
    ACCENT_PRESETS.find((p) => p.id === defaultPresetId)?.name ?? 'Vermilion'

  const hexId = useId()
  const msgId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // A change of accent (a preset, reset, the picker, or a valid hex typed
  // here) replaces the field's contents, unless an error is on screen: then
  // the user's text stays so they can correct it.
  const errorRef = useRef(error)
  errorRef.current = error
  useEffect(() => {
    if (!errorRef.current) setDraft(null)
  }, [accent])

  const fieldValue = draft ?? (isCustom ? accent.custom : base.hex)

  const onHexChange = (raw: string) => {
    setDraft(raw)
    const state = readHexInput(raw)
    if (state.kind === 'invalid-characters') {
      setError(t('settings:accent.hexInvalidCharacters', { value: raw }))
      setNote(null)
      return
    }
    setError(null)
    if (state.kind === 'valid') {
      setAccent({ custom: state.hex })
      setNote(t('settings:accent.hexApplied'))
    } else {
      setNote(t('settings:accent.hexKeepTyping'))
    }
  }

  const onHexCommit = () => {
    if (draft === null) return
    const hex = normalizeHex(draft)
    if (!hex) {
      setError(t('settings:accent.hexInvalid', { value: draft }))
      return
    }
    setError(null)
    setNote(null)
    setDraft(null)
    setAccent({ custom: hex })
  }

  const swatchClass = (checked: boolean) =>
    cn(
      'inline-flex h-8 pointer-coarse:h-11 items-center gap-2 rounded-md border border-border bg-card pl-2 pr-3 text-sm font-medium text-foreground hover:bg-sunken focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring',
      checked && 'border-ink-2 ring-1 ring-ink-2'
    )

  return (
    <Card
      data-testid="accent-settings"
      title={t('settings:accent.title')}
      aside={
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0 text-xs text-brand-text pointer-coarse:h-11"
          disabled={isDefault}
          onClick={() => {
            setError(null)
            setNote(null)
            setDraft(null)
            resetAccent()
          }}
          data-testid="accent-reset"
        >
          {t('settings:accent.resetTo', { name: defaultName })}
        </Button>
      }
    >
      <CardItem
        anchor="settings-appearance-accent"
        column
        className="flex-col items-start"
        title={
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span>{t('settings:accent.current', { name: base.name })}</span>
            <span className="font-mono text-xs font-normal text-muted-foreground">
              {isCustom
                ? base.hex
                : t('settings:accent.presetValues', {
                    light: base.light,
                    dark: base.dark,
                  })}
            </span>
          </span>
        }
        description={t('settings:accent.description')}
        actions={
          <div
            role="radiogroup"
            aria-label={t('settings:accent.title')}
            className="flex flex-wrap items-center gap-2"
          >
            {ACCENT_PRESETS.map((p) => {
              const checked = !isCustom && accent.preset === p.id
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  data-testid={`accent-preset-${p.id}`}
                  onClick={() => {
                    setError(null)
                    setNote(null)
                    setAccent({ preset: p.id })
                  }}
                  className={swatchClass(checked)}
                >
                  <span
                    aria-hidden
                    className="size-4 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.15)]"
                    style={{ backgroundColor: p[theme] }}
                  />
                  {p.name}
                  {p.id === defaultPresetId && (
                    <span className="font-normal text-muted-foreground">
                      {t('settings:accent.presetDefault')}
                    </span>
                  )}
                  {checked && <CheckIcon className="size-3.5" aria-hidden />}
                </button>
              )
            })}
            <label
              role="radio"
              aria-checked={isCustom}
              className={cn(
                swatchClass(isCustom),
                'cursor-pointer focus-within:outline-2 focus-within:outline-solid focus-within:outline-offset-2 focus-within:outline-ring'
              )}
            >
              <input
                type="color"
                data-testid="accent-color-input"
                aria-label={t('settings:accent.pickCustom')}
                className="h-4 w-6 cursor-pointer rounded-sm border border-line-strong bg-transparent p-0"
                value={(isCustom ? accent.custom : base.light).toLowerCase()}
                onInput={(e) => {
                  const hex = normalizeHex((e.target as HTMLInputElement).value)
                  if (hex) previewAccent({ custom: hex })
                }}
                onChange={(e) => {
                  const hex = normalizeHex(e.target.value)
                  if (hex) {
                    setError(null)
                    setAccent({ custom: hex })
                  }
                }}
              />
              {t('settings:accent.custom')}
              {isCustom && <CheckIcon className="size-3.5" aria-hidden />}
            </label>
          </div>
        }
      />

      <CardItem
        title={
          <label htmlFor={hexId}>{t('settings:accent.hexLabel')}</label>
        }
        description={
          <span
            id={msgId}
            role="status"
            className={cn(
              'inline-flex items-start gap-1.5',
              error && 'text-destructive'
            )}
          >
            {error && (
              <OctagonAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            )}
            {error ?? note ?? t('settings:accent.hexHelp')}
          </span>
        }
        actions={
          <input
            id={hexId}
            data-testid="accent-hex-input"
            className={cn(
              'h-8 pointer-coarse:h-11 w-32 rounded-md border border-input bg-card px-2 font-mono text-base text-foreground sm:text-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring',
              error && 'border-destructive'
            )}
            value={fieldValue}
            maxLength={7}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={msgId}
            onChange={(e) => onHexChange(e.target.value)}
            onBlur={onHexCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onHexCommit()
            }}
          />
        }
      />

      <div className="space-y-2 border-b border-border py-3 last:border-none">
        <p className="text-[13px] leading-normal text-muted-foreground">
          {t('settings:accent.onFill', {
            ink:
              tokens.onFill === '#FFFFFF'
                ? t('settings:accent.white')
                : t('settings:accent.nearBlack'),
            ratio: onFillRatio.toFixed(1),
          })}{' '}
          {t('settings:accent.independentOfTheme')}
        </p>
        {proximity && (
          <p className="flex items-start gap-2 rounded-md bg-sunken px-3 py-2 text-xs text-ink-2">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {proximity === 'success'
              ? t('settings:accent.nearSuccess')
              : t('settings:accent.nearDanger')}
          </p>
        )}
      </div>

      <div
        role="group"
        aria-label={t('settings:accent.previewLabel')}
        className="-mx-4 -mb-1 flex flex-wrap items-center gap-2.5 rounded-b-lg border-t border-border bg-sunken px-4 py-3"
      >
        <Button size="sm" tabIndex={-1}>
          {t('settings:accent.previewPrimary')}
        </Button>
        <span className="text-sm font-medium text-brand-text underline-offset-2">
          {t('settings:accent.previewLink')}
        </span>
        <span className="relative px-1 pb-1.5 text-sm text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand-fill">
          {t('settings:accent.previewTab')}
        </span>
        <span className="relative rounded-md bg-accent py-1 pr-2 pl-3 text-sm text-foreground before:absolute before:left-0 before:inset-y-1.5 before:w-0.5 before:rounded-full before:bg-brand-rail">
          {t('settings:accent.previewSelected')}
        </span>
        <span className="inline-flex items-center gap-1 rounded-md bg-success-tint px-2 py-0.5 text-xs font-medium text-success">
          <CheckIcon className="size-3" aria-hidden />
          {t('settings:accent.previewSuccess')}
        </span>
        <span className="inline-flex items-center gap-1 rounded-md bg-destructive-tint px-2 py-0.5 text-xs font-medium text-destructive">
          <OctagonAlert className="size-3" aria-hidden />
          {t('settings:accent.previewError')}
        </span>
        <span className="inline-flex overflow-hidden rounded-md font-mono text-xs">
          <span className="bg-diff-add-bg px-1.5 py-0.5 text-diff-add">
            {t('settings:accent.previewDiffAdded')}
          </span>
          <span className="bg-diff-del-bg px-1.5 py-0.5 text-diff-del">
            {t('settings:accent.previewDiffRemoved')}
          </span>
        </span>
      </div>
    </Card>
  )
}
