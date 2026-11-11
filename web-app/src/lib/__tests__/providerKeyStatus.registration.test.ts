import { describe, it, expect } from 'vitest'
import { registersWithoutKey } from '@/lib/providerKeyStatus'

const withKeySetting = [{ key: 'api-key' }]

describe('registersWithoutKey', () => {
  it('registers a keyless LAN, loopback or single-label provider', () => {
    for (const base_url of [
      'http://192.168.1.20:8000/v1',
      'http://127.0.0.1:8080/v1',
      'http://llm-box:8555/v1',
    ]) {
      expect(
        registersWithoutKey({ provider: 'lan', base_url, settings: withKeySetting })
      ).toBe(true)
    }
  })

  it('registers a provider whose settings declare no key', () => {
    expect(
      registersWithoutKey({
        provider: 'gw',
        base_url: 'https://gateway.example.com/v1',
        settings: [{ key: 'base-url' }],
      })
    ).toBe(true)
  })

  it('leaves a public provider that needs a key unregistered', () => {
    expect(
      registersWithoutKey({
        provider: 'openai',
        base_url: 'https://api.openai.com/v1',
        settings: withKeySetting,
      })
    ).toBe(false)
  })

  it('never registers the built-in engine or a provider with no URL', () => {
    expect(registersWithoutKey({ provider: 'llamacpp', base_url: 'http://127.0.0.1:1' })).toBe(false)
    expect(registersWithoutKey({ provider: 'lan', settings: withKeySetting })).toBe(false)
  })
})
