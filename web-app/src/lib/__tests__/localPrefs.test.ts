import { beforeEach, describe, expect, it } from 'vitest'
import { readJson, writeJson } from '../localPrefs'

describe('localPrefs', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips a value', () => {
    expect(writeJson('k', { a: 1 })).toBe(true)
    expect(readJson('k')).toEqual({ a: 1 })
  })

  it('reads absent and corrupt entries as undefined', () => {
    expect(readJson('missing')).toBeUndefined()
    localStorage.setItem('bad', '{nope')
    expect(readJson('bad')).toBeUndefined()
  })
})
