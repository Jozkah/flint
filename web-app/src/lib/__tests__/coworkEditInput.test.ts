import { describe, it, expect } from 'vitest'
import { normalizeEditInput } from '../coworkEditInput'

describe('normalizeEditInput', () => {
  it('turns the top-level pair into a one-item edits list', () => {
    expect(
      normalizeEditInput({ path: 'a', old_string: 'x', new_string: 'y', replace_all: true })
    ).toEqual({ path: 'a', edits: [{ old_string: 'x', new_string: 'y', replace_all: true }] })
  })

  it('leaves an edits list alone', () => {
    const input = { path: 'a', edits: [{ old_string: 'x', new_string: 'y' }] }
    expect(normalizeEditInput(input)).toBe(input)
  })

  it('leaves incomplete or odd input for the backend to report', () => {
    const partial = { path: 'a', old_string: 'x' }
    expect(normalizeEditInput(partial)).toBe(partial)
    expect(normalizeEditInput(undefined)).toBeUndefined()
    expect(normalizeEditInput('x')).toBe('x')
  })
})
