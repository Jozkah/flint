import { describe, it, expect } from 'vitest'
import {
  validateCustomHeaders,
  applyCustomHeaders,
  looksSecret,
  redactCustomHeaderValues,
  withoutSecretValues,
  MAX_CUSTOM_HEADERS,
} from '../customHeaders'

const row = (header: string, value: string, secret?: boolean) =>
  ({ header, value, ...(secret === undefined ? {} : { secret }) }) as ProviderCustomHeader

describe('validateCustomHeaders', () => {
  it('accepts ordinary headers', () => {
    expect(
      validateCustomHeaders([
        row('X-Tenant', 'acme'),
        row('Ocp-Apim-Subscription-Key', 'abc123', true),
      ])
    ).toEqual([])
  })

  it('names each problem by row and kind', () => {
    const errors = validateCustomHeaders([
      row('', 'x'),
      row('Bad Name', 'x'),
      row('X-Ok', 'line\r\nInjected: yes'),
      row('X-Empty', '   '),
    ])
    expect(errors).toEqual([
      { index: 0, code: 'empty-name' },
      { index: 1, code: 'invalid-name' },
      { index: 2, code: 'invalid-value' },
      { index: 3, code: 'empty-value' },
    ])
  })

  it('refuses a name Jan owns, whatever its case', () => {
    for (const name of [
      'Authorization',
      'x-api-key',
      'X-GOOG-API-KEY',
      'Host',
      'Content-Length',
      'Transfer-Encoding',
      'Connection',
      'Content-Type',
      'Proxy-Authorization',
      'x-jan-session',
      'X-Jan-Anything',
    ]) {
      expect(validateCustomHeaders([row(name, 'v')])).toEqual([
        { index: 0, code: 'reserved' },
      ])
    }
  })

  it('refuses the same name twice, ignoring case', () => {
    expect(
      validateCustomHeaders([row('X-Tenant', 'a'), row('x-tenant', 'b')])
    ).toEqual([{ index: 1, code: 'duplicate' }])
  })

  it('bounds names, values and the number of rows', () => {
    expect(validateCustomHeaders([row('X-' + 'a'.repeat(300), 'v')])).toEqual([
      { index: 0, code: 'too-long' },
    ])
    expect(validateCustomHeaders([row('X-A', 'v'.repeat(9000))])).toEqual([
      { index: 0, code: 'too-long' },
    ])
    const many = Array.from({ length: MAX_CUSTOM_HEADERS + 1 }, (_, i) =>
      row(`X-H${i}`, 'v')
    )
    expect(validateCustomHeaders(many)).toContainEqual({
      index: MAX_CUSTOM_HEADERS,
      code: 'too-many',
    })
  })
})

describe('applyCustomHeaders', () => {
  it('overrides a built-in default of the same name, whatever its case', () => {
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' }
    applyCustomHeaders(headers, {
      custom_header: [row('Anthropic-Version', '2024-01-01')],
    })
    expect(headers).toEqual({ 'Anthropic-Version': '2024-01-01' })
  })

  it('never lets a custom header replace authentication', () => {
    const headers: Record<string, string> = { Authorization: 'Bearer real' }
    applyCustomHeaders(headers, {
      custom_header: [
        row('authorization', 'Bearer spoofed'),
        row('x-jan-session', 'spoofed'),
        row('X-Tenant', 'acme'),
      ],
    })
    expect(headers).toEqual({ Authorization: 'Bearer real', 'X-Tenant': 'acme' })
  })

  it('skips a row that is not valid rather than sending it', () => {
    const headers: Record<string, string> = {}
    applyCustomHeaders(headers, {
      custom_header: [row('X-Bad', 'a\nb'), row('X-Good', 'ok')],
    })
    expect(headers).toEqual({ 'X-Good': 'ok' })
  })

  it('skips a secret row whose value has not been loaded', () => {
    const headers: Record<string, string> = {}
    applyCustomHeaders(headers, {
      custom_header: [row('X-Secret', '', true)],
    })
    expect(headers).toEqual({})
  })

  it('does not send a disabled header, and sends it again once re-enabled', () => {
    const rows = [
      { header: 'X-Tenant', value: 'acme', enabled: false },
      row('X-Region', 'eu'),
    ] as ProviderCustomHeader[]
    expect(applyCustomHeaders({}, { custom_header: rows })).toEqual({
      'X-Region': 'eu',
    })
    rows[0] = { ...rows[0], enabled: true }
    expect(applyCustomHeaders({}, { custom_header: rows })).toEqual({
      'X-Tenant': 'acme',
      'X-Region': 'eu',
    })
  })

  it('trims surrounding whitespace from values', () => {
    const headers: Record<string, string> = {}
    applyCustomHeaders(headers, { custom_header: [row('X-A', '  v  ')] })
    expect(headers).toEqual({ 'X-A': 'v' })
  })
})

describe('secrets', () => {
  it('guesses which names carry credentials', () => {
    expect(looksSecret('Ocp-Apim-Subscription-Key')).toBe(true)
    expect(looksSecret('X-Auth-Token')).toBe(true)
    expect(looksSecret('Cookie')).toBe(true)
    expect(looksSecret('X-Tenant')).toBe(false)
    expect(looksSecret('HTTP-Referer')).toBe(false)
  })

  it('drops secret values and keeps the rest', () => {
    expect(
      withoutSecretValues([row('X-Tenant', 'acme'), row('X-Key', 'hunter22', true)])
    ).toEqual([row('X-Tenant', 'acme'), row('X-Key', '', true)])
  })

  it('redacts every configured secret value from text', () => {
    const text = 'upstream said: bad key hunter22 for tenant acme (hunter22)'
    expect(
      redactCustomHeaderValues(text, {
        custom_header: [row('X-Tenant', 'acme'), row('X-Key', 'hunter22', true)],
      })
    ).toBe('upstream said: bad key <redacted> for tenant acme (<redacted>)')
  })

  it('leaves text alone when there is nothing secret to redact', () => {
    expect(redactCustomHeaderValues('plain', { custom_header: null })).toBe('plain')
  })
})
