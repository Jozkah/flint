import { describe, it, expect } from 'vitest'
import {
  getStatusClass,
  getStatusLabel,
  isMemorySetting,
  maskApiKey,
} from '../providerDetailHelpers'

describe('maskApiKey', () => {
  it('keeps the first and last four characters of a long key', () => {
    expect(maskApiKey('sk-abcdefghijklmnop')).toBe('sk-a***mnop')
  })

  it('keeps only two characters of a short key', () => {
    expect(maskApiKey('12345678')).toBe('12***')
    expect(maskApiKey('abc')).toBe('ab***')
    expect(maskApiKey('')).toBe('***')
  })

  it('never reveals more than eight characters of a key', () => {
    const key = 'sk-ant-api03-SECRETSECRETSECRET'
    const masked = maskApiKey(key)
    expect(masked).not.toContain('SECRETSECRET')
    expect(masked.replace('***', '')).toHaveLength(8)
  })
})

describe('key check status', () => {
  it('words each result', () => {
    expect(getStatusLabel('ok')).toBe('OK')
    expect(getStatusLabel('unauthorized')).toBe('Invalid / revoked key (401)')
    expect(getStatusLabel('forbidden')).toBe('Forbidden (403)')
    expect(getStatusLabel('rate_limited')).toBe(
      'Rate limited / out of credit (429)'
    )
    expect(getStatusLabel('network_error')).toBe('Network error')
    expect(getStatusLabel('anything else')).toBe('Failed')
  })

  it('colours success, soft failures and hard failures apart', () => {
    expect(getStatusClass('ok')).toBe('text-success')
    for (const soft of [
      'unauthorized',
      'forbidden',
      'http_error',
      'network_error',
      'rate_limited',
    ]) {
      expect(getStatusClass(soft)).toBe('text-warning')
    }
    expect(getStatusClass('boom')).toBe('text-destructive')
  })
})

describe('isMemorySetting', () => {
  it('matches memory-related engine options', () => {
    for (const key of ['cache_type_k', 'no_mmap', 'mlock', 'n_batch', 'flash_attn']) {
      expect(isMemorySetting(key), key).toBe(true)
    }
  })

  it('leaves other options out', () => {
    for (const key of ['port', 'threads', 'api_key']) {
      expect(isMemorySetting(key), key).toBe(false)
    }
  })
})
