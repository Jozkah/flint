import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TokenSpeedIndicator } from '@/containers/TokenSpeedIndicator'
import { isMeaningfulSpeed } from '@/lib/tokenSpeed'

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
