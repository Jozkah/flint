import { describe, expect, it } from 'vitest'
import {
  ACCENT_PRESETS,
  ACCENT_SURFACES,
  DEFAULT_ACCENT,
  accentBase,
  applyAccentToDocument,
  contrastRatio,
  deriveAccentTokens,
  normalizeHex,
  readHexInput,
  sanitizeAccentSelection,
  semanticProximity,
} from '../accent'
import css from '../../index.css?raw'

const themes = ['light', 'dark'] as const

describe('normalizeHex and readHexInput', () => {
  it('accepts three and six digits with or without #', () => {
    expect(normalizeHex('#abc')).toBe('#AABBCC')
    expect(normalizeHex('3b6ea5')).toBe('#3B6EA5')
    expect(normalizeHex(' #3B6EA5 ')).toBe('#3B6EA5')
  })
  it('rejects anything that is not a hex colour', () => {
    for (const v of ['#12G4Z9', '#12AB', 'red', '', '#1234567', 42, null])
      expect(normalizeHex(v as never)).toBeNull()
  })
  it('separates bad characters from an unfinished value', () => {
    expect(readHexInput('#12G')).toEqual({ kind: 'invalid-characters' })
    expect(readHexInput('#12A')).toEqual({ kind: 'incomplete' })
    expect(readHexInput('#12ab34')).toEqual({ kind: 'valid', hex: '#12AB34' })
  })
})

describe('deriveAccentTokens', () => {
  const extremes = ['#F4F1A0', '#101820', '#FFFFFF', '#000000', '#00FF00', '#FF0000']
  const bases = [...ACCENT_PRESETS.flatMap((p) => [p.light, p.dark]), ...extremes]

  it.each(themes)('keeps every derived token readable in %s', (theme) => {
    const S = ACCENT_SURFACES[theme]
    for (const base of bases) {
      const t = deriveAccentTokens(base, theme)
      expect(t.fill).toBe(base)
      expect(contrastRatio(t.indicator, S.ground)).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(t.indicator, S.paper)).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(t.text, S.ground)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(t.text, S.paper)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(t.text, S.sidebar)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(t.text, S.sunken)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(t.indicator, S.sidebar)).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(t.rail, S.rail)).toBeGreaterThanOrEqual(3)
      // The better of white and near-black is always at least 4.5:1 on a fill.
      expect(contrastRatio(t.onFill, base)).toBeGreaterThanOrEqual(4.5)
      expect(t.fillHover).not.toBe(base)
      expect(t.fillPressed).not.toBe(t.fillHover)
    }
  })

  it('never puts white text on a light accent', () => {
    expect(deriveAccentTokens('#F4F1A0', 'light').onFill).toBe('#141210')
    expect(deriveAccentTokens('#101820', 'dark').onFill).toBe('#FFFFFF')
  })

  it('keeps the preset fills exactly as designed', () => {
    expect(deriveAccentTokens('#C0412B', 'light').onFill).toBe('#FFFFFF')
    expect(deriveAccentTokens('#E0654D', 'dark').fill).toBe('#E0654D')
  })
})

describe('sanitizeAccentSelection', () => {
  it('defaults to Vermilion', () => {
    expect(sanitizeAccentSelection(undefined)).toEqual(DEFAULT_ACCENT)
    expect(sanitizeAccentSelection({ preset: 'nope' })).toEqual(DEFAULT_ACCENT)
    expect(sanitizeAccentSelection({ custom: '#zz' })).toEqual(DEFAULT_ACCENT)
  })
  it('keeps valid selections', () => {
    expect(sanitizeAccentSelection({ preset: 'moss' })).toEqual({ preset: 'moss' })
    expect(sanitizeAccentSelection({ preset: 'slate' })).toEqual({ preset: 'slate' })
    expect(sanitizeAccentSelection({ custom: '#abc' })).toEqual({ custom: '#AABBCC' })
  })
  it('migrates the previous accent presets without changing the colour', () => {
    expect(sanitizeAccentSelection(undefined, 'gray')).toEqual({ preset: 'vermilion' })
    expect(sanitizeAccentSelection(undefined, 'blue')).toEqual({ custom: '#456BDE' })
    expect(sanitizeAccentSelection(undefined, 'rose')).toEqual({ custom: '#F655B8' })
    // A saved new-style selection wins over the legacy field.
    expect(sanitizeAccentSelection({ preset: 'ink' }, 'blue')).toEqual({ preset: 'ink' })
  })
})

describe('accentBase and semanticProximity', () => {
  it('uses the preset value for the theme and one value for a custom colour', () => {
    expect(accentBase({ preset: 'ink' }, 'dark').hex).toBe('#7FA8D1')
    expect(accentBase({ preset: 'slate' }, 'light').hex).toBe('#46618A')
    expect(accentBase({ preset: 'slate' }, 'dark').name).toBe('Slate blue')
    expect(accentBase({ custom: '#123456' }, 'light').hex).toBe('#123456')
  })
  it('warns near success and danger hues only', () => {
    expect(semanticProximity('#2E7A4C')).toBe('success')
    expect(semanticProximity('#C0412B')).toBe('danger')
    expect(semanticProximity('#2F5D8A')).toBeNull()
  })
})

describe('applyAccentToDocument', () => {
  it('writes the derived variables for the effective theme', () => {
    const el = document.createElement('div')
    el.style.setProperty('--sidebar', '#194D24')
    applyAccentToDocument({ preset: 'moss' }, false, el)
    expect(el.style.getPropertyValue('--primary')).toBe('#4E6E3A')
    expect(el.style.getPropertyValue('--primary-foreground')).toBe('#FFFFFF')
    expect(el.style.getPropertyValue('--sidebar')).toBe('')
    applyAccentToDocument({ preset: 'moss' }, true, el)
    expect(el.style.getPropertyValue('--primary')).toBe('#97B77F')
  })
})

describe('stylesheet surfaces', () => {
  it('match the surfaces the contrast checks assume', () => {
    const light = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const dark = css.match(/\n\.dark\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const read = (block: string, name: string) =>
      block.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))?.[1]?.toUpperCase()
    expect(read(light, 'background')).toBe(ACCENT_SURFACES.light.ground)
    expect(read(light, 'card')).toBe(ACCENT_SURFACES.light.paper)
    expect(read(light, 'rail')).toBe(ACCENT_SURFACES.light.rail)
    expect(read(light, 'sidebar')).toBe(ACCENT_SURFACES.light.sidebar)
    expect(read(light, 'sunken')).toBe(ACCENT_SURFACES.light.sunken)
    expect(read(dark, 'sidebar')).toBe(ACCENT_SURFACES.dark.sidebar)
    expect(read(dark, 'sunken')).toBe(ACCENT_SURFACES.dark.sunken)
    expect(read(dark, 'background')).toBe(ACCENT_SURFACES.dark.ground)
    expect(read(dark, 'card')).toBe(ACCENT_SURFACES.dark.paper)
    expect(read(dark, 'rail')).toBe(ACCENT_SURFACES.dark.rail)
  })
})
