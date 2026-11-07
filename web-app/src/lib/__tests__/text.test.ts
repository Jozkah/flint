import { describe, expect, it } from 'vitest'
import { truncate } from '../text'

describe('truncate', () => {
  it('leaves text that fits unchanged', () => {
    expect(truncate('', 3)).toBe('')
    expect(truncate('abc', 3)).toBe('abc')
  })

  it('cuts to exactly max characters, ending in an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abcdef', 4)).toHaveLength(4)
  })

  it('keeps only the ellipsis for max 1 or less', () => {
    expect(truncate('abc', 1)).toBe('…')
    expect(truncate('abc', 0)).toBe('…')
  })
})
