import { describe, expect, it } from 'vitest'
import {
  MAX_REMEMBERED_COMMANDS,
  normalizeCommand,
  rememberCommand,
  repeatCommandKey,
} from '../repeatedCommand'

describe('repeatCommandKey', () => {
  it('keys a bash command by its normalized text', () => {
    expect(repeatCommandKey('bash', { command: '  ls -la\r\n' })).toBe(
      repeatCommandKey('bash', { command: 'ls -la' })
    )
    expect(repeatCommandKey('bash', '{"command":"ls -la"}')).toBe(
      repeatCommandKey('bash', { command: 'ls -la' })
    )
  })

  it('keeps inner whitespace, which can matter inside quotes', () => {
    expect(repeatCommandKey('bash', { command: 'echo "a  b"' })).not.toBe(
      repeatCommandKey('bash', { command: 'echo "a b"' })
    )
  })

  it('is null for other tools and for calls with no command', () => {
    expect(repeatCommandKey('write', { command: 'ls' })).toBeNull()
    expect(repeatCommandKey('bash', {})).toBeNull()
    expect(repeatCommandKey('bash', { command: '   ' })).toBeNull()
    expect(repeatCommandKey('bash', undefined)).toBeNull()
  })

  it('normalizes line endings and trims', () => {
    expect(normalizeCommand(' a\r\nb\r ')).toBe('a\nb')
  })
})

describe('rememberCommand', () => {
  it('adds once, newest last, and stays bounded', () => {
    expect(rememberCommand(['a', 'b'], 'a')).toEqual(['b', 'a'])
    let list: string[] = []
    for (let i = 0; i < MAX_REMEMBERED_COMMANDS + 5; i++) {
      list = rememberCommand(list, `k${i}`)
    }
    expect(list).toHaveLength(MAX_REMEMBERED_COMMANDS)
    expect(list[0]).toBe('k5')
  })
})
