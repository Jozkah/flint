import { describe, it, expect } from 'vitest'
import {
  SIDEBAR_ITEMS,
  SIDEBAR_DEFAULTS_VERSION,
  SIDEBAR_SECTIONS,
  hiddenForPreset,
  hideableSidebarIds,
  presetOf,
  resolveSidebarDefaults,
  isSidebarItemHidden,
  sanitizeHiddenSidebarItems,
} from '../sidebarItems'

describe('sidebar item registry', () => {
  it('has unique ids and routes that start with a slash', () => {
    const ids = SIDEBAR_ITEMS.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const item of SIDEBAR_ITEMS) {
      expect(item.to().startsWith('/')).toBe(true)
      expect(SIDEBAR_SECTIONS).toContain(item.section)
    }
  })

  it('never lets Settings or New chat be hidden', () => {
    const locked = SIDEBAR_ITEMS.filter((i) => !i.canHide).map((i) => i.id)
    expect(locked).toEqual(expect.arrayContaining(['settings', 'new-chat']))
    expect(hideableSidebarIds()).not.toContain('settings')
    expect(hideableSidebarIds()).not.toContain('new-chat')
  })
})

describe('isSidebarItemHidden', () => {
  it('hides only known, hideable ids', () => {
    expect(isSidebarItemHidden(['studio'], 'studio')).toBe(true)
    expect(isSidebarItemHidden(['studio'], 'logs')).toBe(false)
    expect(isSidebarItemHidden(['settings', 'new-chat'], 'settings')).toBe(false)
    expect(isSidebarItemHidden(['ghost'], 'ghost')).toBe(false)
    expect(isSidebarItemHidden(undefined, 'studio')).toBe(false)
  })

  it('shows an item added later, since nothing saved mentions it', () => {
    expect(isSidebarItemHidden(['logs'], 'schedules')).toBe(false)
  })
})

describe('sanitizeHiddenSidebarItems', () => {
  it('keeps unique strings and drops everything else', () => {
    expect(sanitizeHiddenSidebarItems(['a', 'a', 3, null, 'b'])).toEqual(['a', 'b'])
    expect(sanitizeHiddenSidebarItems('studio')).toEqual([])
    expect(sanitizeHiddenSidebarItems(undefined)).toEqual([])
  })
})

describe("sidebar glyphs", () => {
  it("gives every item its own glyph, so the picker rows are told apart", () => {
    const glyphs = SIDEBAR_ITEMS.map((i) => i.lucide ?? i.icon)
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })
})

describe('sidebar presets', () => {
  it('minimal keeps chat, cowork and Models; everything else hideable goes', () => {
    const hidden = hiddenForPreset('minimal')
    expect(hidden).not.toContain('models')
    expect(hidden).toEqual(hideableSidebarIds().filter((id) => id !== 'models'))
    // New chat and Settings cannot be hidden by any preset.
    expect(hidden).not.toContain('new-chat')
    expect(hidden).not.toContain('settings')
  })

  it('standard sits between minimal and everything', () => {
    const standard = hiddenForPreset('standard')
    expect(standard.length).toBeLessThan(hiddenForPreset('minimal').length)
    expect(standard.length).toBeGreaterThan(0)
    expect(hiddenForPreset('everything')).toEqual([])
  })

  it('recognises the preset a hidden list matches, in any order', () => {
    expect(presetOf([])).toBe('everything')
    expect(presetOf([...hiddenForPreset('minimal')].reverse())).toBe('minimal')
    expect(presetOf(hiddenForPreset('standard'))).toBe('standard')
    expect(presetOf(['studio'])).toBeUndefined()
    // Unknown ids from a newer build do not break the match.
    expect(presetOf(['ghost'])).toBe('everything')
  })
})

describe('resolveSidebarDefaults', () => {
  it('gives a new install with nothing saved the minimal sidebar', () => {
    expect(
      resolveSidebarDefaults({ decidedVersion: 0, hidden: [], existingInstall: false })
    ).toEqual({ hidden: hiddenForPreset('minimal'), decidedVersion: SIDEBAR_DEFAULTS_VERSION })
  })

  it('keeps the full sidebar for an install that was already used', () => {
    expect(
      resolveSidebarDefaults({ decidedVersion: 0, hidden: [], existingInstall: true })
    ).toEqual({ hidden: [], decidedVersion: SIDEBAR_DEFAULTS_VERSION })
  })

  it('keeps a saved choice as it is', () => {
    expect(
      resolveSidebarDefaults({ decidedVersion: 0, hidden: ['logs'], existingInstall: false })
    ).toEqual({ hidden: ['logs'], decidedVersion: SIDEBAR_DEFAULTS_VERSION })
  })

  it('never decides twice: a saved version leaves everything alone', () => {
    for (const existingInstall of [true, false]) {
      expect(
        resolveSidebarDefaults({ decidedVersion: 1, hidden: [], existingInstall })
      ).toBeUndefined()
    }
    expect(
      resolveSidebarDefaults({ decidedVersion: undefined, hidden: [], existingInstall: true })
    ).toBeDefined()
  })
})
