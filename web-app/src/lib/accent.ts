/**
 * Accent colour engine for the JAN Graphite Studio design.
 *
 * The user picks one base colour: a preset (Vermilion, Ink, Moss, Slate blue) or any
 * custom hex value. That base stays the fill of primary actions. Everything
 * that must stay readable against the app's own surfaces is derived from it
 * per theme and checked with WCAG contrast: focus rings and selection markers
 * reach 3:1 against the page, accent-coloured text reaches 4.5:1, the marker on
 * the graphite rail reaches 3:1 against the rail, and text placed on the fill
 * is whichever of white or near-black contrasts more.
 *
 * Semantic colours (success, warning, danger, diff additions and removals) are
 * separate tokens and are never derived from the accent.
 */

export type AccentPresetId = 'vermilion' | 'ink' | 'moss' | 'slate'
export type AccentSelection = { preset: AccentPresetId } | { custom: string }
export type AccentTheme = 'light' | 'dark'

export type AccentPreset = {
  id: AccentPresetId
  name: string
  light: string
  dark: string
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'vermilion', name: 'Vermilion', light: '#C0412B', dark: '#E0654D' },
  { id: 'ink', name: 'Ink', light: '#2F5D8A', dark: '#7FA8D1' },
  { id: 'moss', name: 'Moss', light: '#4E6E3A', dark: '#97B77F' },
  { id: 'slate', name: 'Slate blue', light: '#46618A', dark: '#94AACB' },
]

export const DEFAULT_ACCENT: AccentSelection = { preset: 'vermilion' }

/** The surfaces the derived tokens must stay readable on, per theme: the
 * working pane (ground), raised content (paper), the navigation sidebar, the
 * secondary pane (sunken) and the rail. These mirror `index.css`; a test keeps
 * the two in step. */
export const ACCENT_SURFACES: Record<
  AccentTheme,
  { ground: string; paper: string; sidebar: string; sunken: string; rail: string }
> = {
  light: { ground: '#F7F8F9', paper: '#FFFFFF', sidebar: '#ECEEF1', sunken: '#EFF1F3', rail: '#E3E6EA' },
  dark: { ground: '#1B1C1F', paper: '#222327', sidebar: '#161719', sunken: '#18191B', rail: '#111214' },
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
  /** Selection marker on the graphite rail: 3:1 against the rail. */
  rail: string
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
    indicator: adjustForContrast(base, [T.ground, T.paper, T.sidebar, T.sunken], 3),
    text: adjustForContrast(base, [T.ground, T.paper, T.sidebar, T.sunken], 4.5),
    rail: adjustForContrast(base, [T.rail], 3),
    tint: mix(base, T.paper, theme === 'light' ? 0.13 : 0.22),
    soft: mix(base, T.paper, theme === 'light' ? 0.3 : 0.4),
  }
}

export function presetById(id: unknown): AccentPreset | undefined {
  return ACCENT_PRESETS.find((p) => p.id === id)
}

/** The base colour a selection uses in a theme, and the name shown for it. */
export function accentBase(
  selection: AccentSelection,
  theme: AccentTheme
): { name: string; hex: string; light: string; dark: string } {
  if ('custom' in selection) {
    return {
      name: 'Custom',
      hex: selection.custom,
      light: selection.custom,
      dark: selection.custom,
    }
  }
  const p = presetById(selection.preset) ?? ACCENT_PRESETS[0]
  return { name: p.name, hex: p[theme], light: p.light, dark: p.dark }
}

/** Accent values written by earlier versions (`accentColor` preset names). The
 * old default, `gray`, used the vermilion-like `#f17455` as its primary, so it
 * maps to Vermilion; every other old preset keeps its exact colour as a custom
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
    '--ring': tokens.indicator,
    '--sidebar-primary': tokens.fill,
    '--sidebar-primary-foreground': tokens.onFill,
    '--sidebar-ring': tokens.indicator,
    '--brand': tokens.indicator,
    '--brand-fill': tokens.fill,
    '--brand-fill-hover': tokens.fillHover,
    '--brand-fill-pressed': tokens.fillPressed,
    '--brand-foreground': tokens.onFill,
    '--brand-text': tokens.text,
    '--brand-rail': tokens.rail,
    '--brand-tint': tokens.tint,
    '--brand-soft': tokens.soft,
  }
}

/** Write the derived tokens for the effective theme onto the document root. */
export function applyAccentToDocument(
  selection: AccentSelection,
  isDark: boolean,
  root: HTMLElement = document.documentElement
): void {
  const theme: AccentTheme = isDark ? 'dark' : 'light'
  const vars = accentCssVariables(
    deriveAccentTokens(accentBase(selection, theme).hex, theme)
  )
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  // Earlier versions wrote a tinted sidebar inline; the Graphite sidebar is a
  // neutral surface from the stylesheet.
  root.style.removeProperty('--sidebar')
}
