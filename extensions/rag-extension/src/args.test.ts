import { describe, expect, it } from 'vitest'
import { coerceIntegerArg, coerceStringArrayArg } from './args'

describe('coerceIntegerArg', () => {
  it('passes real integers through', () => {
    expect(coerceIntegerArg(0)).toBe(0)
    expect(coerceIntegerArg(6)).toBe(6)
    expect(coerceIntegerArg(-2)).toBe(-2)
  })

  // janhq/jan#7939: runtimes that serialize every argument as a string used to
  // reach the Rust engine and fail with `invalid type: string "0", expected i64`.
  it('accepts the string spelling of an integer', () => {
    expect(coerceIntegerArg('0')).toBe(0)
    expect(coerceIntegerArg('5')).toBe(5)
    expect(coerceIntegerArg(' 6 ')).toBe(6)
    expect(coerceIntegerArg('+7')).toBe(7)
    expect(coerceIntegerArg('-1')).toBe(-1)
    expect(coerceIntegerArg('5.0')).toBe(5)
  })

  it('refuses anything that is not an exact integer', () => {
    expect(coerceIntegerArg('6.5')).toBeUndefined()
    expect(coerceIntegerArg(6.5)).toBeUndefined()
    expect(coerceIntegerArg('abc')).toBeUndefined()
    expect(coerceIntegerArg('')).toBeUndefined()
    expect(coerceIntegerArg('  ')).toBeUndefined()
    expect(coerceIntegerArg('1e3')).toBeUndefined()
    expect(coerceIntegerArg(NaN)).toBeUndefined()
    expect(coerceIntegerArg(Infinity)).toBeUndefined()
    expect(coerceIntegerArg(Number.MAX_SAFE_INTEGER + 2)).toBeUndefined()
    expect(coerceIntegerArg(true)).toBeUndefined()
    expect(coerceIntegerArg(null)).toBeUndefined()
    expect(coerceIntegerArg(undefined)).toBeUndefined()
    expect(coerceIntegerArg({})).toBeUndefined()
    expect(coerceIntegerArg(['1'])).toBeUndefined()
  })
})

describe('coerceStringArrayArg', () => {
  it('passes a list of ids through', () => {
    expect(coerceStringArrayArg(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('reads the JSON text of a list', () => {
    expect(coerceStringArrayArg('["a","b"]')).toEqual(['a', 'b'])
    expect(coerceStringArrayArg(' ["a"] ')).toEqual(['a'])
  })

  it('treats a bare id as a single-element list', () => {
    expect(coerceStringArrayArg('abc')).toEqual(['abc'])
  })

  it('drops non-string and empty entries', () => {
    expect(coerceStringArrayArg(['a', 1, '', null])).toEqual(['a'])
  })

  it('returns nothing when there is no usable filter', () => {
    expect(coerceStringArrayArg([])).toBeUndefined()
    expect(coerceStringArrayArg('')).toBeUndefined()
    expect(coerceStringArrayArg('[')).toBeUndefined()
    expect(coerceStringArrayArg('[1,2]')).toBeUndefined()
    expect(coerceStringArrayArg(undefined)).toBeUndefined()
    expect(coerceStringArrayArg(42)).toBeUndefined()
  })
})
