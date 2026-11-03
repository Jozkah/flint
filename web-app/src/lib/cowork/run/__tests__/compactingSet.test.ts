import { describe, it, expect } from 'vitest'
import { withCompacting } from '../compactingSet'

describe('withCompacting', () => {
  it('tracks sessions independently', () => {
    let set: ReadonlySet<string> = new Set()
    set = withCompacting(set, 'a', true)
    set = withCompacting(set, 'b', true)
    set = withCompacting(set, 'a', false)
    expect(set.has('a')).toBe(false)
    expect(set.has('b')).toBe(true)
  })

  it('returns the same set when nothing changes', () => {
    const set: ReadonlySet<string> = new Set(['a'])
    expect(withCompacting(set, 'a', true)).toBe(set)
    expect(withCompacting(set, 'b', false)).toBe(set)
  })
})
