/**
 * Accent colour engine for the Flint design.
 *
 * The default accent is Slate: the neutral ink of the interface itself, which
 * the stylesheet already defines, so choosing it clears every inline override.
 * Any other choice (a preset or a custom hex) becomes the fill and gradient of
 * primary actions. Everything that must stay readable against the app's own
 * surfaces is derived from it per theme and checked with WCAG contrast: focus
 * rings and selection markers reach 3:1 against the page, accent-coloured text
 * reaches 4.5:1, and text placed on the fill is whichever of white or
 * near-black contrasts more. In dark mode a custom colour is lifted 12%
 * towards white so it keeps its presence on the near-black surfaces.
 *
 * Semantic colours (success, warning, danger, diff additions and removals) are
 * separate tokens and are never derived from the accent.
 */

export type AccentPresetId =
  | 'neutral'
  | 'vermilion'
  | 'ink'
  | 'moss'
  | 'slate'
  | 'violet'
export type AccentSelection = { preset: AccentPresetId } | { custom: string }
export type AccentTheme = 'light' | 'dark'

export type AccentPreset = {
  id: AccentPresetId
  name: string
  light: string
  dark: string
  /** The interface's own ink: applying it removes the inline overrides. */
  neutral?: boolean
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'neutral', name: 'Slate', light: '#1F2937', dark: '#E6E8EB', neutral: true },
  { id: 'vermilion', name: 'Vermilion', light: '#C0412B', dark: '#E0654D' },
  { id: 'ink', name: 'Ink', light: '#2F5D8A', dark: '#7FA8D1' },
  { id: 'moss', name: 'Moss', light: '#4E6E3A', dark: '#97B77F' },
  { id: 'slate', name: 'Slate blue', light: '#46618A', dark: '#94AACB' },
  { id: 'violet', name: 'Violet', light: '#6D4AFF', dark: '#8C70FF' },
]

export const DEFAULT_ACCENT: AccentSelection = { preset: 'neutral' }

/** The surfaces the derived tokens must stay readable on, per theme: the page
 * behind every frame (ground), raised content (paper) and the inset wells
 * (muted). These mirror `index.css`; a test keeps the two in step. */
export const ACCENT_SURFACES: Record<
  AccentTheme,
  { ground: string; paper: string; muted: string }
> = {
  light: { ground: '#F8F8F8', paper: '#FFFFFF', muted: '#F6F6F6' },
  dark: { ground: '#0A0B0D', paper: '#131519', muted: '#0F1114' },
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i
const WHITE = '#FFFFFF'
const NEAR_BLACK = '#141210'

/** `#abc`, `abc`, `#AABBCC` → `#AABBCC`; anything else → null. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = value.trim().match(HEX_RE)
  if (!m) return null
  let h = m[1]
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  return `#${h.toUpperCase()}`
}

/** Validation for a hex field while the user types. */
export type HexInputState =
  | { kind: 'valid'; hex: string }
  | { kind: 'incomplete' }
  | { kind: 'invalid-characters' }

export function readHexInput(raw: string): HexInputState {
  const v = raw.trim()
  if (!/^#?[0-9a-f]*$/i.test(v)) return { kind: 'invalid-characters' }
  const digits = v.replace('#', '')
  if (digits.length === 6) return { kind: 'valid', hex: normalizeHex(v)! }
  return { kind: 'incomplete' }
}

const hexRgb = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
]

const rgbHex = (rgb: number[]): string =>
  `#${rgb
    .map((x) =>
      Math.round(Math.max(0, Math.min(1, x)) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')
    .toUpperCase()}`

export function relativeLuminance(hex: string): number {
  const w = [0.2126, 0.7152, 0.0722]
  return hexRgb(hex)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
    .reduce((acc, c, i) => acc + c * w[i], 0)
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (p, q) => q - p
  )
  return (x + 0.05) / (y + 0.05)
}

type Hsl = { h: number; s: number; l: number }

export function toHsl(hex: string): Hsl {
  const [r, g, b] = hexRgb(hex)
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  let s = 0
  let h = 0
  if (mx !== mn) {
    const d = mx - mn
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  return { h, s, l }
}

export function fromHsl(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return rgbHex([f(0), f(8), f(4)])
}

const mix = (a: string, b: string, t: number): string => {
  const A = hexRgb(a)
  const B = hexRgb(b)
  return rgbHex(A.map((c, i) => c * t + B[i] * (1 - t)))
}

/** Move lightness away from the backgrounds until every one of them is met. */
function adjustForContrast(hex: string, backgrounds: string[], target: number) {
  const { h, s } = toHsl(hex)
  let { l } = toHsl(hex)
  const darken = relativeLuminance(backgrounds[0]) > 0.3
  let out = hex
  for (
    let i = 0;
    i < 100 && Math.min(...backgrounds.map((b) => contrastRatio(out, b))) < target;
    i++
  ) {
    l = Math.max(0, Math.min(1, l + (darken ? -0.01 : 0.01)))
    out = fromHsl(h, s, l)
  }
  return out
}

export type AccentTokens = {
  /** The chosen colour, used as the fill of primary actions. */
  fill: string
  fillHover: string
  fillPressed: string
  /** Text and icons placed on the fill. */
  onFill: string
  /** Rings, markers and selected outlines: 3:1 against the page. */
  indicator: string
  /** Accent-coloured text and links: 4.5:1 against the page. */
  text: string
  /** Top of the fill gradient: the fill lifted towards white. */
  gradTop: string
  /** Subtle selected background. */
  tint: string
  /** Stronger selected background and borders. */
  soft: string
}

export function deriveAccentTokens(base: string, theme: AccentTheme): AccentTokens {
  const T = ACCENT_SURFACES[theme]
  const onFill =
    contrastRatio(base, WHITE) >= contrastRatio(base, NEAR_BLACK)
      ? WHITE
      : NEAR_BLACK
  const { h, s, l } = toHsl(base)
  // Hover and pressed step away from the extremes, so a very dark or very
  // light accent still visibly responds.
  const shift = l < 0.2 ? 1 : l > 0.75 ? -1 : onFill === WHITE ? -1 : 1
  const step = (d: number) => fromHsl(h, s, Math.max(0, Math.min(1, l + shift * d)))
  return {
    fill: base,
    fillHover: step(0.07),
    fillPressed: step(0.13),
    onFill,
    indicator: adjustForContrast(base, [T.ground, T.paper, T.muted], 3),
    text: adjustForContrast(base, [T.ground, T.paper, T.muted], 4.5),
    gradTop: mix(base, WHITE, 0.84),
    tint: mix(base, T.paper, theme === 'light' ? 0.13 : 0.22),
    soft: mix(base, T.paper, theme === 'light' ? 0.3 : 0.4),
  }
}

export function presetById(id: unknown): AccentPreset | undefined {
  return ACCENT_PRESETS.find((p) => p.id === id)
}

/** A custom colour as shown in dark mode: 12% of the way to white. */
export function liftForDark(hex: string): string {
  return mix(hex, WHITE, 0.88)
}

export function isNeutralSelection(selection: AccentSelection): boolean {
  return 'preset' in selection && !!presetById(selection.preset)?.neutral
}

/** The base colour a selection uses in a theme, and the name shown for it. */
export function accentBase(
  selection: AccentSelection,
  theme: AccentTheme
): { name: string; hex: string; light: string; dark: string } {
  if ('custom' in selection) {
    const dark = liftForDark(selection.custom)
    return {
      name: 'Custom',
      hex: theme === 'dark' ? dark : selection.custom,
      light: selection.custom,
      dark,
    }
  }
  const p = presetById(selection.preset) ?? ACCENT_PRESETS[0]
  return { name: p.name, hex: p[theme], light: p.light, dark: p.dark }
}

/** Accent values written by earlier versions (`accentColor` preset names). The
 * old default, `gray`, maps to today's default; every other old preset keeps its exact colour as a custom
 * accent, so an upgrade does not silently change what the user chose. */
const LEGACY_PRIMARY: Record<string, string> = {
  red: '#F0614B',
  orange: '#E9A23F',
  green: '#88BA42',
  emerald: '#38AB51',
  teal: '#38AB8D',
  cyan: '#45BBDE',
  blue: '#456BDE',
  purple: '#865EEA',
  pink: '#D55EF3',
  rose: '#F655B8',
}

export function sanitizeAccentSelection(
  raw: unknown,
  legacyAccentColor?: unknown
): AccentSelection {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (typeof r.custom === 'string') {
      const hex = normalizeHex(r.custom)
      if (hex) return { custom: hex }
    }
    if (presetById(r.preset)) return { preset: r.preset as AccentPresetId }
  }
  if (typeof legacyAccentColor === 'string') {
    if (legacyAccentColor === 'gray') return DEFAULT_ACCENT
    if (presetById(legacyAccentColor))
      return { preset: legacyAccentColor as AccentPresetId }
    const legacy = LEGACY_PRIMARY[legacyAccentColor]
    if (legacy) return { custom: legacy }
  }
  return DEFAULT_ACCENT
}

export function sameSelection(a: AccentSelection, b: AccentSelection): boolean {
  if ('custom' in a && 'custom' in b) return a.custom === b.custom
  if ('preset' in a && 'preset' in b) return a.preset === b.preset
  return false
}

/** Hue within 24° of the success or danger colour, with enough saturation to
 * read as that hue. The settings page warns, it does not refuse. */
export function semanticProximity(base: string): 'success' | 'danger' | null {
  const { h, s } = toHsl(base)
  const deg = h * 360
  const near = (t: number) =>
    Math.min(Math.abs(deg - t), 360 - Math.abs(deg - t)) < 24 && s > 0.25
  if (near(143)) return 'success'
  if (near(4)) return 'danger'
  return null
}

/** CSS custom properties the design tokens read. */
export function accentCssVariables(tokens: AccentTokens): Record<string, string> {
  return {
    '--primary': tokens.fill,
    '--primary-foreground': tokens.onFill,
    '--primary-hover': tokens.fillHover,
    '--primary-pressed': tokens.fillPressed,
    '--grad': `linear-gradient(180deg, ${tokens.gradTop} 0%, ${tokens.fill} 64.697%)`,
    '--on-grad': tokens.onFill,
    '--ring': tokens.indicator,
    '--acc': tokens.indicator,
    '--acc-text': tokens.text,
    '--acc-soft': tokens.soft,
    '--acc-tint': tokens.tint,
  }
}

/** Every property an accent can have written inline, including the ones older
 * versions wrote, so switching back to the neutral default clears them all. */
const ACCENT_PROPERTIES = [
  '--primary',
  '--primary-foreground',
  '--primary-hover',
  '--primary-pressed',
  '--grad',
  '--on-grad',
  '--ring',
  '--acc',
  '--acc-text',
  '--acc-soft',
  '--acc-tint',
  '--sidebar',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-ring',
  '--brand',
  '--brand-fill',
  '--brand-fill-hover',
  '--brand-fill-pressed',
  '--brand-foreground',
  '--brand-text',
  '--brand-rail',
  '--brand-tint',
  '--brand-soft',
]

/** Write the derived tokens for the effective theme onto the document root. */
export function applyAccentToDocument(
  selection: AccentSelection,
  isDark: boolean,
  root: HTMLElement = document.documentElement
): void {
  for (const k of ACCENT_PROPERTIES) root.style.removeProperty(k)
  if (isNeutralSelection(selection)) return
  const theme: AccentTheme = isDark ? 'dark' : 'light'
  const vars = accentCssVariables(
    deriveAccentTokens(accentBase(selection, theme).hex, theme)
  )
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
}
