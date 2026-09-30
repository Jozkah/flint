import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TokenSpeedIndicator } from '@/containers/TokenSpeedIndicator'
import { isMeaningfulSpeed, speedStats } from '@/lib/tokenSpeed'

vi.mock('@/hooks/useInterfaceSettings', () => ({
  useInterfaceSettings: (sel: (s: { showTokenSpeed: boolean }) => unknown) =>
    sel({ showTokenSpeed: true }),
}))

describe('isMeaningfulSpeed', () => {
  it('rejects tiny replies and very short durations', () => {
    expect(isMeaningfulSpeed(7, 6)).toBe(false)
    expect(isMeaningfulSpeed(7, 5000)).toBe(false)
    expect(isMeaningfulSpeed(500, 100)).toBe(false)
  })
  it('accepts a real generation', () => {
    expect(isMeaningfulSpeed(1284, 30350)).toBe(true)
    expect(isMeaningfulSpeed(40, undefined)).toBe(true)
  })
})

describe('TokenSpeedIndicator', () => {
  it('hides tokens/sec for a 7-token reply but keeps the count', () => {
    render(
      <TokenSpeedIndicator
        metadata={{ tokenSpeed: { tokenSpeed: 1167, tokenCount: 7, durationMs: 6 } }}
      />
    )
    expect(screen.queryByText(/tokens\/sec/)).toBeNull()
    expect(screen.getByText('(7 tokens)')).toBeTruthy()
  })
  it('shows tokens/sec for a long reply', () => {
    render(
      <TokenSpeedIndicator
        metadata={{
          tokenSpeed: { tokenSpeed: 42.3, tokenCount: 1284, durationMs: 30350 },
        }}
      />
    )
    expect(screen.getByText('42 tokens/sec')).toBeTruthy()
  })
})

describe('a short reply still gets a speed', () => {
  it('counts a 20-token reply over a quarter second, which used to be hidden', () => {
    expect(isMeaningfulSpeed(20, 300)).toBe(true)
    expect(isMeaningfulSpeed(8, 250)).toBe(true)
  })
})

describe('speedStats', () => {
  it('gives the latest measurable reply and a token-weighted average', () => {
    const stats = speedStats([
      { tokenSpeed: 100, tokenCount: 100, durationMs: 1000 },
      { tokenSpeed: 50, tokenCount: 300, durationMs: 6000 },
      { tokenSpeed: 900, tokenCount: 3, durationMs: 4 }, // too short to time
      undefined,
    ])
    expect(stats.last).toBe(50)
    expect(stats.average).toBeCloseTo((100 * 100 + 50 * 300) / 400)
  })

  it('is empty when nothing could be measured', () => {
    expect(speedStats([])).toEqual({})
    expect(speedStats([{ tokenSpeed: 900, tokenCount: 3, durationMs: 4 }])).toEqual({})
  })
})
