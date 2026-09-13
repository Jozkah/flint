import { useEffect, useId, useRef, useState } from 'react'
import { CheckIcon, InfoIcon, RotateCcwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
 * Settings > Appearance > Accent. Presets, a native colour picker and a hex
 * field that validates as the user types. A valid value applies immediately
 * and is saved; an invalid one is explained and leaves the accent unchanged.
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

  return (
    <div className="flex flex-col gap-4 w-full" data-testid="accent-settings">
      <div className="flex items-center gap-3 min-w-0">
        <span
          aria-hidden
          className="size-9 shrink-0 rounded-full border border-black/15"
          style={{ backgroundColor: base.hex }}
        />
        <div className="min-w-0">
          <div className="font-medium text-foreground">
            {t('settings:accent.current', { name: base.name })}{' '}
            <span className="font-mono text-xs text-muted-foreground">
              {isCustom
                ? base.hex
                : t('settings:accent.presetValues', {
                    light: base.light,
                    dark: base.dark,
                  })}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('settings:accent.onFill', {
              ink:
                tokens.onFill === '#FFFFFF'
                  ? t('settings:accent.white')
                  : t('settings:accent.nearBlack'),
              ratio: onFillRatio.toFixed(1),
            })}{' '}
            {t('settings:accent.independentOfTheme')}
          </p>
        </div>
      </div>

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
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-full border border-line-strong bg-card pl-2 pr-3 text-sm font-medium text-foreground hover:bg-sunken',
                checked && 'border-foreground ring-1 ring-foreground'
              )}
            >
              <span
                aria-hidden
                className="size-5 rounded-full border border-black/15"
                style={{ backgroundColor: p[theme] }}
              />
              {p.name}
              {checked && <CheckIcon className="size-3.5" aria-hidden />}
            </button>
          )
        })}
        <label
          role="radio"
          aria-checked={isCustom}
          className={cn(
            'inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-line-strong bg-card pl-2 pr-3 text-sm font-medium text-foreground hover:bg-sunken focus-within:outline-2 focus-within:outline-ring',
            isCustom && 'border-foreground ring-1 ring-foreground'
          )}
        >
          <input
            type="color"
            data-testid="accent-color-input"
            aria-label={t('settings:accent.pickCustom')}
            className="h-5 w-7 cursor-pointer rounded-full border border-line-strong bg-transparent p-0"
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

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={hexId} className="text-sm text-muted-foreground">
          {t('settings:accent.hexLabel')}
        </label>
        <input
          id={hexId}
          data-testid="accent-hex-input"
          className={cn(
            'h-9 w-32 rounded-md border border-input bg-card px-2 font-mono text-base text-foreground sm:text-sm',
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
        <Button
          variant="outline"
          size="sm"
          disabled={isDefault}
          onClick={() => {
            setError(null)
            setNote(null)
            setDraft(null)
            resetAccent()
          }}
          data-testid="accent-reset"
        >
          <RotateCcwIcon aria-hidden />
          {t('settings:accent.reset')}
        </Button>
        <span
          id={msgId}
          role="status"
          className={cn(
            'basis-full text-xs text-muted-foreground',
            error && 'text-destructive'
          )}
        >
          {error ?? note ?? t('settings:accent.hexHelp')}
        </span>
      </div>

      {proximity && (
        <p className="flex items-start gap-2 rounded-md bg-sunken px-3 py-2 text-xs text-ink-2">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {proximity === 'success'
            ? t('settings:accent.nearSuccess')
            : t('settings:accent.nearDanger')}
        </p>
      )}

      <div
        aria-label={t('settings:accent.previewLabel')}
        className="flex flex-wrap items-center gap-2.5 rounded-md border border-dashed border-line-strong bg-background p-3"
      >
        <Button size="sm" tabIndex={-1}>
          {t('settings:accent.previewPrimary')}
        </Button>
        <Button size="sm" variant="outline" tabIndex={-1}>
          {t('settings:accent.previewSecondary')}
        </Button>
        <span className="border-b-2 border-brand px-1 pb-1 text-sm text-foreground">
          {t('settings:accent.previewTab')}
        </span>
        <span className="rounded-md bg-brand-tint px-2 py-1 text-sm text-foreground shadow-[inset_2px_0_0_var(--brand)]">
          {t('settings:accent.previewSelected')}
        </span>
        <span className="text-sm font-medium text-brand-text">
          {t('settings:accent.previewLink')}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-success-tint px-2 py-0.5 text-xs text-success">
          <CheckIcon className="size-3" aria-hidden />
          {t('settings:accent.previewSuccess')}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-destructive-tint px-2 py-0.5 text-xs text-destructive">
          {t('settings:accent.previewError')}
        </span>
      </div>
    </div>
  )
}
