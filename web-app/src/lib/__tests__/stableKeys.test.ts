import { describe, expect, it } from 'vitest'
import { stableKeys } from '../stableKeys'

describe('stableKeys', () => {
  it('keeps unique items and suffixes repeats', () => {
    const keys = stableKeys(['a', 'b', 'a', 'a'])
    expect(new Set(keys).size).toBe(4)
    expect(keys[0]).toBe('a')
    expect(keys[1]).toBe('b')
  })
})
