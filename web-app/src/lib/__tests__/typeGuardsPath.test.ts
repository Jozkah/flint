import { describe, expect, it } from 'vitest'
import { isRecord } from '../typeGuards'
import { basename } from '../path'

describe('isRecord', () => {
  it('accepts plain objects and class instances only', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord(new Date())).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord([])).toBe(false)
    expect(isRecord('x')).toBe(false)
    expect(isRecord(1)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
  })
})

describe('basename', () => {
  it('handles both separators and trailing slashes', () => {
    expect(basename('C:\\a\\b')).toBe('b')
    expect(basename('/a/b/')).toBe('b')
    expect(basename('C:\\dir\\')).toBe('dir')
    expect(basename('a')).toBe('a')
    expect(basename('')).toBe('')
  })
})
