import { describe, it, expect } from 'vitest'
import { classifyModelLocation, isLocalModel } from '@/lib/modelLocation'
import type { EndpointDiagnostics } from '@/lib/providerFetch'

const diag = (
  over: Partial<EndpointDiagnostics> = {}
): EndpointDiagnostics => ({
  host: 'v100',
  port: 8080,
  localName: true,
  candidates: [],
  selected: null,
  suppressedPublic: false,
  responded: null,
  ...over,
})

describe('classifyModelLocation', () => {
  it('treats Jan own runtime as local whatever the URL looks like', () => {
    expect(classifyModelLocation({ builtInEngine: true })).toBe('local')
    expect(
      classifyModelLocation({
        builtInEngine: true,
        baseUrl: 'https://api.openai.com/v1',
      })
    ).toBe('local')
  })

  it('files loopback, LAN, Tailscale and local-suffix endpoints under local', () => {
    for (const url of [
      'http://localhost:1337/v1',
      'http://127.0.0.1:8080/v1',
      'http://[::1]:8080/v1',
      'http://192.168.1.9:8080/v1',
      'http://10.0.0.5:8080/v1',
      'http://172.16.4.4:8080/v1',
      'http://100.86.12.4:8080/v1',
      'http://[fd00::1]:8080/v1',
      'http://workstation.local:8080/v1',
      'http://box.ts.net:8080/v1',
      'http://server.lan:8080/v1',
      'http://thing.home.arpa:8080/v1',
    ]) {
      expect(classifyModelLocation({ baseUrl: url })).toBe('local')
    }
  })

  it('files a hosted API under remote', () => {
    for (const url of [
      'https://api.openai.com/v1',
      'https://openrouter.ai/api/v1',
      'https://generativelanguage.googleapis.com/v1beta',
    ]) {
      expect(classifyModelLocation({ baseUrl: url })).toBe('remote')
    }
  })

  it('will not call an unresolved short hostname remote', () => {
    // The bug: `v100` filed next to the hosted APIs. Until the resolver has
    // answered, it is checking -- never remote.
    expect(classifyModelLocation({ baseUrl: 'http://v100:8080/v1' })).toBe(
      'checking'
    )
  })

  it('calls a short hostname local once it resolves to a private address', () => {
    expect(
      classifyModelLocation({
        baseUrl: 'http://v100:8080/v1',
        diagnostics: diag({
          selected: '100.86.12.4',
          candidates: [
            { address: '100.86.12.4', class: 'tailscale', eligible: true },
          ],
        }),
      })
    ).toBe('local')
  })

  it('picks the private answer when DNS returned both', () => {
    // The reported shape: a public Cloudflare record and the tailnet address.
    // The transport dials the private one, so the model is local.
    expect(
      classifyModelLocation({
        baseUrl: 'http://v100:8080/v1',
        diagnostics: diag({
          selected: '100.86.12.4',
          suppressedPublic: true,
          candidates: [
            { address: '2606:4700::1', class: 'public', eligible: false },
            { address: '100.86.12.4', class: 'tailscale', eligible: true },
          ],
        }),
      })
    ).toBe('local')
  })

  it('calls a short hostname remote only when it genuinely resolves publicly', () => {
    expect(
      classifyModelLocation({
        baseUrl: 'http://shortname:8080/v1',
        diagnostics: diag({
          host: 'shortname',
          selected: '104.16.133.229',
          candidates: [
            { address: '104.16.133.229', class: 'public', eligible: true },
          ],
        }),
      })
    ).toBe('remote')
  })

  it('stays checking while nothing has resolved yet', () => {
    expect(
      classifyModelLocation({
        baseUrl: 'http://v100:8080/v1',
        diagnostics: diag({ candidates: [], selected: null }),
      })
    ).toBe('checking')
  })

  it('says unknown rather than remote when there is no endpoint at all', () => {
    expect(classifyModelLocation({})).toBe('unknown')
    expect(classifyModelLocation({ baseUrl: '' })).toBe('unknown')
    expect(classifyModelLocation({ baseUrl: '   ' })).toBe('unknown')
  })

  it('reclassifies when the endpoint is edited', () => {
    const before = { baseUrl: 'https://api.openai.com/v1' }
    const after = { baseUrl: 'http://192.168.1.9:8080/v1' }
    expect(classifyModelLocation(before)).toBe('remote')
    expect(classifyModelLocation(after)).toBe('local')
  })

  it('classifies a restored provider from its stored endpoint alone', () => {
    // Nothing about the classification depends on how the provider was added.
    const restored = JSON.parse(
      JSON.stringify({ baseUrl: 'http://100.86.12.4:8080/v1' })
    )
    expect(isLocalModel(restored)).toBe(true)
  })

  it('never puts one model in both groups', () => {
    const inputs = [
      { baseUrl: 'http://127.0.0.1:1337/v1' },
      { baseUrl: 'https://api.openai.com/v1' },
      { baseUrl: 'http://v100:8080/v1' },
      { builtInEngine: true },
    ]
    for (const input of inputs) {
      const location = classifyModelLocation(input)
      expect([location === 'local', location === 'remote'].filter(Boolean).length)
        .toBeLessThanOrEqual(1)
    }
  })
})
