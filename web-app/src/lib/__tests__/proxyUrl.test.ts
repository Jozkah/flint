import { describe, it, expect } from 'vitest'
import { validateProxyUrl } from '../proxyUrl'

describe('validateProxyUrl', () => {
  it('accepts the schemes the backend supports', () => {
    expect(validateProxyUrl('http://h:8080')).toBe('ok')
    expect(validateProxyUrl('https://h')).toBe('ok')
  })

  it('accepts a bare host:port, which the backend reads as http', () => {
    expect(validateProxyUrl('h:8080')).toBe('ok')
    expect(validateProxyUrl('proxy.corp.example')).toBe('ok')
  })

  it('treats empty as fine', () => {
    expect(validateProxyUrl('')).toBe('empty')
    expect(validateProxyUrl('   ')).toBe('empty')
  })

  it('flags a scheme the backend does not support', () => {
    expect(validateProxyUrl('ftp://h')).toBe('scheme')
    expect(validateProxyUrl('socks5://h:1080')).toBe('scheme')
  })

  it('flags a missing host or stray whitespace', () => {
    expect(validateProxyUrl('http://')).toBe('invalid')
    expect(validateProxyUrl('http://a b')).toBe('invalid')
    expect(validateProxyUrl('http://:8080')).toBe('invalid')
  })
})
