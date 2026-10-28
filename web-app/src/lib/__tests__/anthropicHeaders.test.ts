import { describe, expect, it } from 'vitest'
import { applyProviderAuthHeader, ensureAnthropicHeaders } from '../anthropicHeaders'

function auth(p: Parameters<typeof applyProviderAuthHeader>[0]) {
  const h: Record<string, string> = {}
  applyProviderAuthHeader(p, h, 'k')
  return h
}

describe('anthropic provider detection', () => {
  it('bedrock-anthropic with openai api_type uses bearer', () => {
    expect(auth({ api_type: 'openai', provider: 'bedrock-anthropic' })).toEqual({
      Authorization: 'Bearer k',
    })
  })

  it('a base url merely containing the word is not anthropic', () => {
    expect(auth({ base_url: 'https://anthropic-proxy.corp/v1' })).toEqual({
      Authorization: 'Bearer k',
    })
  })

  it('api.anthropic.com host is anthropic', () => {
    expect(auth({ base_url: 'https://api.anthropic.com/v1' })).toEqual({
      'x-api-key': 'k',
    })
  })

  it('provider name anthropic is anthropic', () => {
    expect(auth({ provider: 'anthropic' })).toEqual({ 'x-api-key': 'k' })
  })

  it('api_type anthropic with a custom base url is anthropic', () => {
    expect(
      auth({ api_type: 'anthropic', base_url: 'https://gw.example.com/v1' })
    ).toEqual({ 'x-api-key': 'k' })
  })

  it('an invalid base url is not anthropic', () => {
    expect(auth({ base_url: 'not a url' })).toEqual({ Authorization: 'Bearer k' })
  })

  it('ensureAnthropicHeaders leaves non-anthropic providers alone', () => {
    const h: Record<string, string> = {}
    ensureAnthropicHeaders({ api_type: 'openai', provider: 'anthropic' }, h)
    expect(h).toEqual({})
    ensureAnthropicHeaders({ provider: 'anthropic' }, h)
    expect(h['anthropic-version']).toBe('2023-06-01')
  })
})
