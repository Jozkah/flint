import { describe, it, expect } from 'vitest'
import { validateMcpJson, validateMcpServerConfig } from '../mcpConfigValidation'

describe('validateMcpServerConfig', () => {
  it('accepts a well typed config', () => {
    expect(
      validateMcpServerConfig({
        command: 'npx',
        args: ['-y', 'x'],
        env: { A: '1' },
        active: true,
      })
    ).toBeNull()
  })

  it('names the field that has the wrong type', () => {
    expect(validateMcpServerConfig({ command: 5 }, 'a')).toContain('"command"')
    expect(validateMcpServerConfig({ args: [1, 2] })).toContain('"args"')
    expect(validateMcpServerConfig({ env: { A: 1 } })).toContain('"env"')
    expect(validateMcpServerConfig('x')).toContain('object')
  })
})

describe('validateMcpJson', () => {
  it('checks every server in a map and in mcpServers', () => {
    expect(validateMcpJson({ a: { command: 'x' } })).toBeNull()
    expect(validateMcpJson({ mcpServers: { a: { command: 1 } } })).toContain('"a"')
    expect(validateMcpJson({ mcpServers: [] })).toContain('mcpServers')
  })

  it('checks a single server when a name is given', () => {
    expect(validateMcpJson({ command: 'x', args: ['a'] }, 'a')).toBeNull()
    expect(validateMcpJson({ args: 'a' }, 'a')).toContain('"args"')
  })
})
