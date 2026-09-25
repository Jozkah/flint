import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { CheckIcon, InfoIcon, OctagonAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Switch } from '@/components/ui/switch'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Card } from '@/containers/Card'
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

/* ---------- colour maths for the custom picker (HSV, as the picker is drawn) ---------- */

const toHex = (r: number, g: number, b: number) =>
  '#' +
  [r, g, b]
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')
    .toUpperCase()

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function hsvToHex(h: number, s: number, v: number) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return toHex(f(5) * 255, f(3) * 255, f(1) * 255)
}

function hexToHsv(hex: string): Hsv {
  const [r, g, b] = hexToRgb(hex).map((x) => x / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
  }
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max }
}

type Hsv = { h: number; s: number; v: number }

/** Colours offered under the picker; a colour the user applies joins the front. */
const RECENT_DEFAULTS = [
  '#E0654D',
  '#E0A526',
  '#2BB673',
  '#1FA2C4',
  '#5B6CF0',
  '#B45BD8',
  '#E0558F',
]

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/**
 * Tracks a pointer across an element and reports its position as fractions of
 * the element's box, for the picker's saturation/value square and hue bar.
 */
function useDragArea(onMove: (x: number, y: number) => void) {
  const [dragging, setDragging] = useState(false)
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    const report = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect()
      onMove(
        clamp01((clientX - r.left) / (r.width || 1)),
        clamp01((clientY - r.top) / (r.height || 1))
      )
    }
    report(e.clientX, e.clientY)
    setDragging(true)
    const move = (ev: PointerEvent) => report(ev.clientX, ev.clientY)
    const up = () => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return { dragging, onPointerDown }
}

const thumbClass =
  'pointer-events-none absolute -mt-2 -ml-2 size-4 rounded-full border-[2.5px] border-white shadow-[0_0_0_1px_rgba(0,0,0,.25),0_2px_6px_rgba(0,0,0,.35)]'

/**
 * The custom colour picker: a saturation/value square, a hue bar, the value
 * as hex and RGB, a row of recent colours, and Cancel / Use colour. Nothing
 * changes until Use colour, so a drag across the square never flashes the
 * whole interface through every colour on the way.
 */
function CustomColorPicker({
  initial,
  recent,
  onCancel,
  onApply,
}: {
  initial: string
  recent: string[]
  onCancel: () => void
  onApply: (hex: string) => void
}) {
  const { t } = useTranslation()
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(initial))
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  const hex = hsvToHex(hsv.h, hsv.s, hsv.v)
  const onFill = contrastRatio(hex, '#FFFFFF') >= 3 ? '#FFFFFF' : '#111318'

  const sv = useDragArea((x, y) => {
    setHexDraft(null)
    setHsv((c) => ({ ...c, s: x, v: 1 - y }))
  })
  const hue = useDragArea((x) => {
    setHexDraft(null)
    setHsv((c) => ({ ...c, h: x * 360 }))
  })

  return (
    <div
      data-testid="accent-custom-picker"
      className="flex flex-col gap-2.5 p-1.5"
    >
      <div
        role="slider"
        aria-label={t('settings:accent.pickerSaturation')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        tabIndex={0}
        onPointerDown={sv.onPointerDown}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.1 : 0.02
          const d =
            e.key === 'ArrowRight'
              ? [step, 0]
              : e.key === 'ArrowLeft'
                ? [-step, 0]
                : e.key === 'ArrowUp'
                  ? [0, step]
                  : e.key === 'ArrowDown'
                    ? [0, -step]
                    : null
          if (!d) return
          e.preventDefault()
          setHexDraft(null)
          setHsv((c) => ({ ...c, s: clamp01(c.s + d[0]), v: clamp01(c.v + d[1]) }))
        }}
        className="relative h-[150px] cursor-crosshair touch-none rounded-[10px] shadow-[inset_0_0_0_1px_rgba(0,0,0,.1)] outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40 motion-safe:animate-rise-in [animation-delay:50ms]"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
        }}
      >
        <span
          className={cn(
            thumbClass,
            sv.dragging
              ? 'scale-125'
              : 'transition-[left,top,transform] duration-250 ease-expo'
          )}
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            background: hex,
          }}
        />
      </div>
      <div
        role="slider"
        aria-label={t('settings:accent.pickerHue')}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        tabIndex={0}
        onPointerDown={hue.onPointerDown}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 15 : 3
          const d =
            e.key === 'ArrowRight' || e.key === 'ArrowUp'
              ? step
              : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
                ? -step
                : 0
          if (!d) return
          e.preventDefault()
          setHexDraft(null)
          setHsv((c) => ({ ...c, h: (c.h + d + 360) % 360 }))
        }}
        className="relative h-3.5 cursor-ew-resize touch-none rounded-full bg-[linear-gradient(to_right,#f00,#ff0_17%,#0f0_33%,#0ff_50%,#00f_67%,#f0f_83%,#f00)] outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40 motion-safe:animate-rise-in [animation-delay:100ms]"
      >
        <span
          className={cn(
            thumbClass,
            'top-1/2',
            hue.dragging
              ? 'scale-125'
              : 'transition-[left,transform] duration-250 ease-expo'
          )}
          style={{
            left: `${(hsv.h / 360) * 100}%`,
            background: `hsl(${hsv.h} 100% 50%)`,
          }}
        />
      </div>
      <div className="flex items-center gap-2 motion-safe:animate-rise-in [animation-delay:150ms]">
        <span
          aria-hidden
          className="size-[30px] shrink-0 rounded-lg shadow-[inset_0_0_0_1px_rgba(0,0,0,.15)] transition-colors duration-200"
          style={{ background: hex }}
        />
        <input
          aria-label={t('settings:accent.hexLabel')}
          data-testid="accent-picker-hex"
          className="h-[30px] w-[92px] rounded-lg border-[0.8px] border-border bg-card px-2 font-mono text-xs text-foreground outline-hidden transition-[border-color,box-shadow] focus:border-border-strong focus:ring-[3px] focus:ring-ring/20"
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          value={hexDraft ?? hex}
          onChange={(e) => {
            setHexDraft(e.target.value)
            const next = normalizeHex(e.target.value)
            if (next && /^#?[0-9a-f]{6}$/i.test(e.target.value.trim()))
              setHsv(hexToHsv(next))
          }}
          onBlur={() => setHexDraft(null)}
        />
        <span className="ml-auto font-mono text-[11.5px] text-muted-foreground">
          {hexToRgb(hex).join(', ')}
        </span>
      </div>
      <div className="flex justify-between gap-1.5">
        {recent.map((c, i) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            onClick={() => {
              setHexDraft(null)
              setHsv(hexToHsv(c))
            }}
            className="size-[26px] rounded-lg shadow-[inset_0_0_0_1px_rgba(0,0,0,.15)] transition-transform duration-200 ease-expo outline-hidden hover:scale-115 hover:-rotate-6 focus-visible:ring-[3px] focus-visible:ring-ring/40 motion-safe:animate-pop"
            style={{ background: c, animationDelay: `${i * 35}ms` }}
          />
        ))}
      </div>
      <div className="flex justify-end gap-1.5 border-t border-dashed border-border pt-2">
        <Button variant="surface" size="sm" onClick={onCancel}>
          {t('common:cancel')}
        </Button>
        <Button
          size="sm"
          data-testid="accent-picker-apply"
          onClick={() => onApply(hex)}
          style={{
            background: `linear-gradient(180deg, color-mix(in oklab, ${hex}, #fff 16%), ${hex} 65%)`,
            color: onFill,
            borderColor: hex,
          }}
        >
          {t('settings:accent.useColour')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Settings > Appearance > Accent colour. Presets as swatch radios (the
 * selected one is raised and ticked, never tinted with the accent), a custom
 * colour picker that opens in a popover, and a hex field that validates as the
 * user types. A valid value applies immediately and is saved; an invalid one
 * is explained and leaves the accent unchanged. A sample row shows the
 * accent's roles next to success and error, so their meanings stay apart.
 */
export function AccentSettings() {
  const { t } = useTranslation()
  const accent = useInterfaceSettings((s) => s.accent)
  const setAccent = useInterfaceSettings((s) => s.setAccent)
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
    ACCENT_PRESETS.find((p) => p.id === defaultPresetId)?.name ?? 'Slate'

  const hexId = useId()
  const msgId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [recent, setRecent] = useState<string[]>(RECENT_DEFAULTS)
  const lastCustom = isCustom ? accent.custom : recent[0]

  // A change of accent (a preset, reset, the picker, or a valid hex typed
  // here) replaces the field's contents, unless an error is on screen: then
  // the user's text stays so they can correct it.
  const errorRef = useRef(error)
  errorRef.current = error
  useEffect(() => {
    if (!errorRef.current) setDraft(null)
  }, [accent])

  const fieldValue = draft ?? (isCustom ? accent.custom : base.hex)

  const clearMessages = () => {
    setError(null)
    setNote(null)
  }

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
    clearMessages()
    setDraft(null)
    setAccent({ custom: hex })
  }

  const applyCustom = useCallback(
    (hex: string) => {
      setPickerOpen(false)
      setError(null)
      setNote(null)
      setRecent((r) => [hex, ...r.filter((c) => c !== hex)].slice(0, 7))
      setAccent({ custom: hex })
    },
    [setAccent]
  )

  const swatchClass = (checked: boolean) =>
    cn(
      'group/sw relative inline-flex h-9 items-center gap-2 rounded-[9px] border-[0.8px] border-border bg-card py-1.5 pr-2.5 pl-1.5 text-[12.5px] font-medium text-foreground transition-[border-color,box-shadow,transform] duration-150 ease-expo outline-hidden hover:-translate-y-px hover:border-border-strong focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:h-11',
      checked && 'border-border-strong shadow-lift'
    )
  const chipClass =
    'size-[22px] shrink-0 rounded-[7px] shadow-[inset_0_0_0_1px_rgba(0,0,0,.12)] transition-transform duration-350 ease-expo group-hover/sw:scale-110 group-hover/sw:-rotate-6'
  const tick = (
    <span
      aria-hidden
      className="grid size-4 place-items-center rounded-full bg-grad text-on-grad motion-safe:animate-pop"
    >
      <CheckIcon className="size-2.5" strokeWidth={3} />
    </span>
  )

  return (
    <Card
      data-testid="accent-settings"
      anchor="settings-appearance-accent"
      title={t('settings:accent.title')}
      aside={
        <Button
          variant="outline"
          size="xs"
          disabled={isDefault}
          onClick={() => {
            clearMessages()
            setDraft(null)
            resetAccent()
          }}
          data-testid="accent-reset"
        >
          {t('settings:accent.resetTo', { name: defaultName })}
        </Button>
      }
    >
      <div className="flex flex-col gap-1.5 px-0.5 pt-[11px] pb-1">
        <div className="text-[13px] leading-tight font-medium text-foreground">
          {t('settings:accent.current', { name: base.name })}
        </div>
        <div className="font-mono text-xs text-muted-foreground">
          {isCustom
            ? base.hex
            : t('settings:accent.presetValues', {
                light: base.light,
                dark: base.dark,
              })}
        </div>
        <div className="text-xs leading-[1.4] text-muted-foreground">
          {t('settings:accent.description')}
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label={t('settings:accent.title')}
        className="flex flex-wrap gap-2 pt-1.5 pb-3"
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
                clearMessages()
                setAccent({ preset: p.id })
              }}
              className={swatchClass(checked)}
            >
              <span
                aria-hidden
                className={chipClass}
                style={{ backgroundColor: p[theme] }}
              />
              {p.name}
              {p.id === defaultPresetId && (
                <small className="text-[11px] font-normal text-muted-foreground">
                  {t('settings:accent.presetDefault')}
                </small>
              )}
              {checked && tick}
            </button>
          )
        })}
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              role="radio"
              aria-checked={isCustom}
              aria-haspopup="dialog"
              data-testid="accent-custom"
              className={cn(swatchClass(isCustom), 'isolate')}
            >
              <span aria-hidden className="relative">
                {/* A slowly turning colour ring says "any colour" before the
                    picker is even open. */}
                <span
                  className="absolute -inset-1 -z-10 rounded-[9px] bg-[conic-gradient(from_0deg,#ff4d4d,#ffb84d,#f6ff4d,#4dff88,#4dd2ff,#6a4dff,#ff4dd8,#ff4d4d)] motion-safe:animate-[spin_6s_linear_infinite]"
                  style={{
                    WebkitMask:
                      'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px))',
                    mask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px))',
                  }}
                />
                <span
                  className={cn(chipClass, 'block shadow-[0_0_0_2px_var(--card)]')}
                  style={{ backgroundColor: lastCustom }}
                />
              </span>
              {t('settings:accent.custom')}
              {isCustom ? (
                tick
              ) : (
                <small className="font-mono text-[11px] font-normal text-muted-foreground">
                  {lastCustom}
                </small>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[280px] p-1.5 motion-safe:data-[state=open]:animate-cp-in"
          >
            <CustomColorPicker
              initial={lastCustom}
              recent={recent}
              onCancel={() => setPickerOpen(false)}
              onApply={applyCustom}
            />
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex flex-col gap-2.5 border-t border-dashed border-border px-0.5 py-[11px] sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label
            htmlFor={hexId}
            className="text-[13px] leading-tight font-medium text-foreground"
          >
            {t('settings:accent.hexLabel')}
          </label>
          <span
            id={msgId}
            role="status"
            className={cn(
              'inline-flex items-start gap-1.5 text-xs leading-[1.4] text-muted-foreground',
              error && 'text-destructive'
            )}
          >
            {error && (
              <OctagonAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            )}
            {error ?? note ?? t('settings:accent.hexHelp')}
          </span>
        </div>
        <span
          className={cn(
            'inline-flex h-8 shrink-0 items-center gap-1.5 self-start rounded-lg border-[0.8px] border-border bg-card pr-1 pl-2 transition-[border-color,box-shadow] focus-within:border-border-strong focus-within:ring-[3px] focus-within:ring-ring/20 sm:self-auto pointer-coarse:h-11',
            error && 'border-destructive'
          )}
        >
          <i
            aria-hidden
            className="size-4 rounded-[5px] shadow-[inset_0_0_0_1px_rgba(0,0,0,.15)] transition-colors duration-300"
            style={{ background: base.hex }}
          />
          <input
            id={hexId}
            data-testid="accent-hex-input"
            className="h-7 w-[100px] bg-transparent px-1 font-mono text-[13px] text-foreground outline-hidden"
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
        </span>
      </div>

      <p className="mb-1.5 px-0.5 text-[12.5px] leading-normal text-muted-foreground">
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
        <p className="mb-1.5 flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-fg-2">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {proximity === 'success'
            ? t('settings:accent.nearSuccess')
            : t('settings:accent.nearDanger')}
        </p>
      )}

      <div
        role="group"
        aria-label={t('settings:accent.previewLabel')}
        className="mb-3 flex flex-wrap items-center gap-3.5 rounded-[10px] bg-muted p-2.5"
      >
        <Button size="sm" tabIndex={-1}>
          {t('settings:accent.previewPrimary')}
        </Button>
        <span className="text-[13px] font-medium text-acc-text underline underline-offset-2">
          {t('settings:accent.previewLink')}
        </span>
        <span className="border-b-2 border-primary pb-[3px] text-[12.5px] text-foreground">
          {t('settings:accent.previewTab')}
        </span>
        <span className="rounded-md bg-acc-soft px-2.5 py-1 text-[12.5px] text-foreground shadow-[inset_2px_0_0_var(--primary)]">
          {t('settings:accent.previewSelected')}
        </span>
        <Switch
          checked
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none"
        />
        <Chip tone="ok" dot>
          {t('settings:accent.previewSuccess')}
        </Chip>
        <Chip tone="err" dot>
          {t('settings:accent.previewError')}
        </Chip>
      </div>
    </Card>
  )
}
