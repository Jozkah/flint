import { describe, it, expect } from 'vitest'
import { decodeWebCiteHref, isHttpUrl } from '../webUrl'

describe('decodeWebCiteHref', () => {
  it('decodes an http(s) url', () => {
    expect(
      decodeWebCiteHref('#webcite-' + encodeURIComponent('https://a.com/x?y=1'))
    ).toBe('https://a.com/x?y=1')
  })
  it('rejects non-http schemes', () => {
    expect(decodeWebCiteHref('#webcite-javascript%3Aalert(1)')).toBeNull()
    expect(decodeWebCiteHref('#webcite-file%3A%2F%2F%2Fc%3A%2Fx')).toBeNull()
  })
  it('does not throw on malformed percent-encoding', () => {
    expect(decodeWebCiteHref('#webcite-%E0%A4%A')).toBeNull()
  })
})

describe('isHttpUrl', () => {
  it('accepts only http(s)', () => {
    expect(isHttpUrl('http://a.b')).toBe(true)
    expect(isHttpUrl('data:text/html,x')).toBe(false)
    expect(isHttpUrl('nope')).toBe(false)
  })
})
