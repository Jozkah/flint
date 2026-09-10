import { describe, it, expect } from 'vitest'
import { predefinedProviders } from '@/constants/providers'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import { getProviderTitle } from '@/lib/utils'

/**
 * llmman (adapted from janhq/jan#8824) is a local, keyless OpenAI-compatible
 * server. What matters for this fork is that listing it costs nothing: it
 * points at loopback, carries no key, and so is never registered with the
 * backend at startup -- `syncRemoteProviders` only registers keyed providers.
 */
describe('llmman provider preset', () => {
  const preset = predefinedProviders.find((p) => p.provider === 'llmman')

  it('is offered as a predefined provider', () => {
    expect(preset).toBeDefined()
  })

  it('points at loopback, never a remote host', () => {
    const url = new URL(preset!.base_url as string)
    expect(['localhost', '127.0.0.1', '[::1]']).toContain(url.hostname)
  })

  it('carries no API key, so startup never registers or contacts it', () => {
    expect(preset!.api_key).toBe('')
    expect(providerHasRemoteApiKeys(preset as never)).toBe(false)
  })

  it('keeps its lowercase name', () => {
    expect(getProviderTitle('llmman')).toBe('llmman')
  })
})
