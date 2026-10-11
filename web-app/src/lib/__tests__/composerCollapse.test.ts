import { describe, expect, it } from 'vitest'
import { COLLAPSE_STEPS, collapsedParts } from '../composerCollapse'

describe('collapsedParts', () => {
  it('collapses nothing when wide or when the width is unknown', () => {
    expect(collapsedParts(900).size).toBe(0)
    expect(collapsedParts(0).size).toBe(0)
    expect(collapsedParts(null).size).toBe(0)
  })

  it('collapses in priority order as the row narrows', () => {
    const order = COLLAPSE_STEPS.map((s) => s.part)
    expect(order).toEqual(['runSettingsLabel', 'folderName', 'accessLabel', 'chipText'])
    const at = (w: number) => [...collapsedParts(w)]
    expect(at(600)).toEqual(['runSettingsLabel'])
    expect(at(500)).toEqual(['runSettingsLabel', 'folderName'])
    expect(at(420)).toEqual(['runSettingsLabel', 'folderName', 'accessLabel'])
    expect(at(300)).toEqual(order)
  })

  it('never collapses a later part before an earlier one', () => {
    for (let w = 100; w < 800; w += 7) {
      const got = collapsedParts(w)
      let seenKept = false
      for (const { part } of COLLAPSE_STEPS) {
        if (!got.has(part)) seenKept = true
        else expect(seenKept).toBe(false)
      }
    }
  })
})
