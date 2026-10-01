import { describe, expect, it } from 'vitest'
import { draftAcceptancePercent } from '@/lib/tokenSpeed'

describe('draftAcceptancePercent', () => {
  it('is the share of proposed tokens the model kept, rounded', () => {
    expect(draftAcceptancePercent({ draftTokens: 40, draftAccepted: 30 })).toBe(75)
    expect(draftAcceptancePercent({ draftTokens: 3, draftAccepted: 1 })).toBe(33)
  })

  it('is null when no draft ran', () => {
    expect(draftAcceptancePercent({})).toBeNull()
    expect(draftAcceptancePercent({ draftTokens: 0, draftAccepted: 0 })).toBeNull()
  })

  it('stays within 0 to 100 for odd input', () => {
    expect(draftAcceptancePercent({ draftTokens: 10, draftAccepted: 25 })).toBe(100)
    expect(draftAcceptancePercent({ draftTokens: 10 })).toBe(0)
    expect(draftAcceptancePercent({ draftTokens: 10, draftAccepted: -4 })).toBe(0)
  })
})
