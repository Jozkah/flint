import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_MIN_W,
  PANEL_DEFAULT_W,
  PANEL_MIN_W,
  WIDTH_STORAGE_KEY,
  clampPanelWidth,
  expandedPanelWidth,
  maxPanelWidth,
  readStoredWidth,
  toggledPanelWidth,
  writeStoredWidth,
} from '../inspectorWidth'

const memory = () => {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

describe('output rail width', () => {
  it('allows up to 70% of a wide window', () => {
    expect(maxPanelWidth(2000)).toBe(1400)
    expect(clampPanelWidth(5000, 2000)).toBe(1400)
  })

  it('always leaves the conversation its minimum', () => {
    // 70% of 1000 is 700, which would leave 300 for the conversation.
    expect(maxPanelWidth(1000)).toBe(1000 - CONVERSATION_MIN_W)
    expect(clampPanelWidth(900, 1000)).toBe(640)
  })

  it('never goes under the panel minimum, even in a tiny window', () => {
    expect(maxPanelWidth(400)).toBe(PANEL_MIN_W)
    expect(clampPanelWidth(10, 2000)).toBe(PANEL_MIN_W)
    expect(clampPanelWidth(Number.NaN, 2000)).toBe(PANEL_DEFAULT_W)
  })

  it('expands to near-full width', () => {
    expect(expandedPanelWidth(1800)).toBe(1800 - CONVERSATION_MIN_W)
  })

  it('toggles between default and wide', () => {
    expect(toggledPanelWidth(PANEL_DEFAULT_W, 2000)).toBe(1400)
    expect(toggledPanelWidth(1400, 2000)).toBe(PANEL_DEFAULT_W)
    expect(toggledPanelWidth(PANEL_MIN_W, 2000)).toBe(1400)
  })

  it('persists and reads back a width, ignoring junk', () => {
    const store = memory()
    expect(readStoredWidth(store)).toBeNull()
    writeStoredWidth(812.4, store)
    expect(store.getItem(WIDTH_STORAGE_KEY)).toBe('812')
    expect(readStoredWidth(store)).toBe(812)
    store.setItem(WIDTH_STORAGE_KEY, 'wide')
    expect(readStoredWidth(store)).toBeNull()
    store.setItem(WIDTH_STORAGE_KEY, '12')
    expect(readStoredWidth(store)).toBeNull()
  })
})
