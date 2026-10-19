import { describe, expect, it } from 'vitest'
import { SMALL_CONTEXT_WINDOW, smallContextActive } from '../smallContext'
import { toolsForWindow } from '../leanTools'
import { skillCatalogBlock } from '../skillCatalog'

describe('smallContextActive', () => {
  it('auto: on at or below 64K, off above, off when the window is unknown', () => {
    expect(smallContextActive('auto', 32_768)).toBe(true)
    expect(smallContextActive('auto', 50_000)).toBe(true)
    expect(smallContextActive('auto', SMALL_CONTEXT_WINDOW)).toBe(true)
    expect(smallContextActive('auto', SMALL_CONTEXT_WINDOW + 1)).toBe(false)
    expect(smallContextActive('auto', 0)).toBe(false)
    expect(smallContextActive(undefined, 262_144)).toBe(false)
  })

  it('always and never override the window', () => {
    expect(smallContextActive('always', 262_144)).toBe(true)
    expect(smallContextActive('always', 0)).toBe(true)
    expect(smallContextActive('never', 8_192)).toBe(false)
  })
})

describe('small-context tools and skills', () => {
  it('drops the low-value tools at any window once the mode is on', () => {
    const tools = { show_widget: 1, image_search: 2, web_search: 3 }
    expect(Object.keys(toolsForWindow(tools, 50_000, false, true))).toEqual(['web_search'])
    expect(toolsForWindow(tools, 50_000, true, false)).toBe(tools)
  })

  it('lists skill names only, with a pointer to skill_list for the rest', () => {
    const skills = Array.from({ length: 80 }, (_, i) => ({
      name: `skill-number-${i}`,
      description: 'A long description that the compact catalog must not carry along. '.repeat(3),
    }))
    const full = skillCatalogBlock(skills as never)
    const compact = skillCatalogBlock(skills as never, undefined, true)
    expect(compact).toContain('skill_read')
    expect(compact).toContain('skill_list')
    expect(compact).not.toContain('must not carry')
    expect(compact.length).toBeLessThan(full.length / 4)
  })
})
