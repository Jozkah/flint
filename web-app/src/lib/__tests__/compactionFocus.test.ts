import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/utilityAgents', () => ({ runUtilityAgent: vi.fn() }))
vi.mock('@/lib/model-factory', () => ({ ModelFactory: {} }))
vi.mock('@/hooks/useModelProvider', () => ({ useModelProvider: {} }))
vi.mock('@/hooks/useAppState', () => ({ useAppState: {} }))

import { withFocus } from '../compactionSummarizer'

describe('withFocus', () => {
  it('leaves the prompt alone without a focus', () => {
    expect(withFocus('SYS')).toBe('SYS')
    expect(withFocus('SYS', '   ')).toBe('SYS')
  })
  it('appends the focus as guidance after the rules', () => {
    const out = withFocus('SYS', '  the auth refactor ')
    expect(out.startsWith('SYS\n\n')).toBe(true)
    expect(out.endsWith('the auth refactor')).toBe(true)
  })
  it('bounds the focus', () => {
    expect(withFocus('S', 'x'.repeat(5000)).length).toBeLessThan(2300)
  })
})
