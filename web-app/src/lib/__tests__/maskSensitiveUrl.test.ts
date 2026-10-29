import { describe, expect, it } from 'vitest'
import { maskSensitiveUrl } from '../maskSensitiveUrl'

describe('maskSensitiveUrl', () => {
  it('masks secret query values case-insensitively and keeps the rest', () => {
    expect(
      maskSensitiveUrl('https://mcp.example.com/sse?API_KEY=abc&mode=fast')
    ).toBe('https://mcp.example.com/sse?API_KEY=******&mode=fast')
  })

  it('masks user:pass credentials', () => {
    expect(maskSensitiveUrl('https://me:pw@mcp.example.com/')).toBe(
      'https://******:******@mcp.example.com/'
    )
  })

  it('masks the whole query of an unparsable url', () => {
    expect(maskSensitiveUrl('not a url?token=x')).toBe('not a url?******')
    expect(maskSensitiveUrl('not a url')).toBe('not a url')
    expect(maskSensitiveUrl('')).toBe('')
  })
})
