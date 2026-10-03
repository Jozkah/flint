import { describe, it, expect } from 'vitest'
import {
  parseDecimalInput,
  readCommittedDecimal,
  isDecimalDraft,
  clampDecimal,
  withinBounds,
} from '../parseDecimalInput'

describe('parseDecimalInput', () => {
  it.each([
    ['0.5', 0.5],
    ['0,5', 0.5],
    ['.5', 0.5],
    [',5', 0.5],
    ['-1.25', -1.25],
    ['-0,75', -0.75],
    ['1', 1],
    ['  2.5 ', 2.5],
  ])('reads %s as %d', (raw, value) => {
    expect(parseDecimalInput(raw)).toEqual({ status: 'valid', value })
  })

  it.each(['0.', '0,', '-', '+', '.', ',', '-.', '-0.'])(
    'treats %s as a number still being typed',
    (raw) => {
      expect(parseDecimalInput(raw).status).toBe('partial')
    }
  )

  it.each(['', '   '])('treats %j as empty', (raw) => {
    expect(parseDecimalInput(raw).status).toBe('empty')
  })

  it.each(['1e', '1e3', 'abc', '1.2.3', '0,5,5', '--1', 'NaN', 'Infinity', '1 2'])(
    'rejects %s',
    (raw) => {
      expect(parseDecimalInput(raw).status).toBe('invalid')
      expect(isDecimalDraft(raw)).toBe(false)
    }
  )

  it('never yields NaN', () => {
    for (const raw of ['', '-', '.', '1e', 'x', '0.', '0,5']) {
      const parsed = parseDecimalInput(raw)
      if (parsed.status === 'valid') expect(Number.isNaN(parsed.value)).toBe(false)
    }
    expect(parseDecimalInput(null).status).toBe('empty')
    expect(parseDecimalInput(undefined).status).toBe('empty')
  })
})

describe('readCommittedDecimal', () => {
  it('finishes a trailing separator', () => {
    expect(readCommittedDecimal('0.')).toBe(0)
    expect(readCommittedDecimal('5,')).toBe(5)
    expect(readCommittedDecimal('-3.')).toBe(-3)
  })
  it('has no answer for nothing or junk', () => {
    expect(readCommittedDecimal('')).toBeNull()
    expect(readCommittedDecimal('-')).toBeNull()
    expect(readCommittedDecimal('.')).toBeNull()
    expect(readCommittedDecimal('1e')).toBeNull()
  })
})

describe('clampDecimal / withinBounds', () => {
  it('clamps to either bound', () => {
    expect(clampDecimal(5, 0, 2)).toBe(2)
    expect(clampDecimal(-5, 0, 2)).toBe(0)
    expect(clampDecimal(1.5, 0, 2)).toBe(1.5)
    expect(clampDecimal(9)).toBe(9)
  })
  it('reports whether a value is inside', () => {
    expect(withinBounds(1, 0, 2)).toBe(true)
    expect(withinBounds(3, 0, 2)).toBe(false)
    expect(withinBounds(-1, 0)).toBe(false)
  })
})
