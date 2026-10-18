import { describe, it, expect } from 'vitest'
import {
  SIDEBAR_ITEMS,
  SIDEBAR_SECTIONS,
  hideableSidebarIds,
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
