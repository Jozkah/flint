import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_NOTE_CHARS, useModelRouting } from '../useModelRouting'

beforeEach(() => useModelRouting.setState({ mode: 'off', pool: [] }))

describe('useModelRouting', () => {
  it('is off with no models by default', () => {
    expect(useModelRouting.getState().mode).toBe('off')
    expect(useModelRouting.getState().pool).toEqual([])
  })

  it('adds a model once, keeps its note when ticked again, and removes it', () => {
    const s = useModelRouting.getState()
    s.setIncluded('anthropic', 'sonnet', true)
    s.setIncluded('anthropic', 'sonnet', true)
    expect(useModelRouting.getState().pool).toEqual([{ provider: 'anthropic', model: 'sonnet' }])
    useModelRouting.getState().setNote('anthropic', 'sonnet', 'best for code')
    useModelRouting.getState().setIncluded('anthropic', 'sonnet', true)
    expect(useModelRouting.getState().pool[0].note).toBe('best for code')
    useModelRouting.getState().setIncluded('anthropic', 'sonnet', false)
    expect(useModelRouting.getState().pool).toEqual([])
  })

  it('shortens a long note and clears an empty one', () => {
    useModelRouting.getState().setIncluded('p', 'm', true)
    useModelRouting.getState().setNote('p', 'm', 'x'.repeat(MAX_NOTE_CHARS + 50))
    expect(useModelRouting.getState().pool[0].note).toHaveLength(MAX_NOTE_CHARS)
    useModelRouting.getState().setNote('p', 'm', '')
    expect(useModelRouting.getState().pool[0].note).toBeUndefined()
  })

  it('changes only the model asked about', () => {
    const s = useModelRouting.getState()
    s.setIncluded('a', '1', true)
    s.setIncluded('b', '2', true)
    useModelRouting.getState().setNote('a', '1', 'note')
    expect(useModelRouting.getState().pool.find((m) => m.provider === 'b')?.note).toBeUndefined()
    useModelRouting.getState().setMode('ask')
    expect(useModelRouting.getState().mode).toBe('ask')
  })
})
