import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
}))

import { useCampaignSettings } from '../useCampaignSettings'

describe('useCampaignSettings', () => {
  beforeEach(() => {
    useCampaignSettings.setState({ maxParallel: 4 })
  })

  it('defaults to 4', () => {
    expect(useCampaignSettings.getState().maxParallel).toBe(4)
  })

  it('clamps what is set into 1..6', () => {
    const { setMaxParallel } = useCampaignSettings.getState()
    setMaxParallel(0)
    expect(useCampaignSettings.getState().maxParallel).toBe(1)
    setMaxParallel(99)
    expect(useCampaignSettings.getState().maxParallel).toBe(6)
    setMaxParallel(3)
    expect(useCampaignSettings.getState().maxParallel).toBe(3)
    setMaxParallel(Number.NaN)
    expect(useCampaignSettings.getState().maxParallel).toBe(4)
  })

  it('does not trust an out-of-range saved value', async () => {
    const persisted = { maxParallel: 40 }
    const merged = useCampaignSettings.persist.getOptions().merge?.(
      persisted,
      useCampaignSettings.getState()
    )
    expect(merged?.maxParallel).toBe(6)
  })
})
