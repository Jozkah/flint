import { describe, it, expect } from 'vitest'
import { predefinedProviders } from '@/constants/providers'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import { getProviderTitle } from '@/lib/utils'

/**
 * A local Ollama is a keyless OpenAI-compatible server on loopback 11434, like
 * the llmman preset; Ollama Cloud (key, ollama.com) stays a separate entry.
 */
describe('local ollama provider preset', () => {
  const preset = predefinedProviders.find((p) => p.provider === 'ollama')

  it('is offered alongside ollama-cloud', () => {
    expect(preset).toBeDefined()
    expect(
      predefinedProviders.some((p) => p.provider === 'ollama-cloud')
    ).toBe(true)
  })

  it('points at loopback port 11434 over the OpenAI-compatible path', () => {
    const url = new URL(preset!.base_url as string)
    expect(url.hostname).toBe('localhost')
    expect(url.port).toBe('11434')
    expect(url.pathname).toBe('/v1')
  })

  it('carries no API key', () => {
    expect(preset!.api_key).toBe('')
    expect(providerHasRemoteApiKeys(preset as never)).toBe(false)
  })

  it('has a readable name', () => {
    expect(getProviderTitle('ollama')).toBe('Ollama')
  })
})
