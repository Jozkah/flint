import { describe, expect, it } from 'vitest'
import { buildProviderListRequest } from '@/lib/providerListRequest'

describe('buildProviderListRequest', () => {
  it('authenticates Anthropic with x-api-key and anthropic-version, not Bearer', () => {
    const { headers, urls } = buildProviderListRequest(
      { provider: 'anthropic', base_url: 'https://api.anthropic.com/v1' },
      'sk-ant-test'
    )
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(headers['Authorization']).toBeUndefined()
    expect(urls[0]).toBe('https://api.anthropic.com/v1/models')
  })

  it('leaves OpenAI-style providers on Bearer with no Anthropic headers', () => {
    const { headers } = buildProviderListRequest(
      { provider: 'openai', base_url: 'https://api.openai.com/v1' },
      'sk-test'
    )
    expect(headers['Authorization']).toBe('Bearer sk-test')
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['anthropic-version']).toBeUndefined()
  })

  it('sends Azure its api-key header and api-version', () => {
    const { headers, urls } = buildProviderListRequest(
      {
        provider: 'azure',
        base_url: 'https://x.openai.azure.com/openai?api-version=2024-10-21',
      },
      'az-key'
    )
    expect(headers['api-key']).toBe('az-key')
    expect(urls[0]).toContain('api-version=2024-10-21')
  })
})
