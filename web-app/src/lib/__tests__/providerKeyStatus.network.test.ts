import { describe, expect, it } from 'vitest'
import { providerKeyStatus } from '../providerKeyStatus'
import { networkSide } from '../modelLocation'
import { locationKind } from '../modelPickerItems'

const custom = (base_url: string) => ({
  provider: 'v100b',
  base_url,
  api_key: '',
  settings: [{ key: 'api-key' }, { key: 'base-url' }],
})

// The badge and the model picker answer "is this on my network?" with one
// rule: a working keyless tailnet box must not read "No API key".
describe('a keyless provider on the user network', () => {
  const onNetwork = [
    'http://v100:8556/v1',
    'http://100.64.0.7:8556/v1',
    'http://100.127.255.1:8080/v1',
    'http://gpu.tail1234.ts.net:8080/v1',
    'http://192.168.1.5:8080/v1',
    'http://10.0.0.2:8080/v1',
    'http://169.254.10.1:8080/v1',
    'http://box.local:8080/v1',
    'http://localhost:1337/v1',
    'http://127.0.0.1:18451/v1',
  ]

  it.each(onNetwork)('%s needs no key, and the picker lists it as local', (url) => {
    expect(providerKeyStatus(custom(url))).toBe('keyless')
    expect(networkSide({ baseUrl: url })).toBe('local')
    expect(locationKind(custom(url) as never)).toBe('local')
  })

  it('a hosted endpoint still needs a key', () => {
    const url = 'https://api.example.com/v1'
    expect(providerKeyStatus(custom(url))).toBe('missing')
    expect(networkSide({ baseUrl: url })).toBe('remote')
    expect(locationKind(custom(url) as never)).toBe('remote')
  })

  it('an address outside 100.64.0.0/10 is not the tailnet', () => {
    expect(providerKeyStatus(custom('http://100.128.0.1:8080/v1'))).toBe('missing')
  })

  it('no address says nothing', () => {
    expect(networkSide({ baseUrl: '' })).toBe('unknown')
  })
})
