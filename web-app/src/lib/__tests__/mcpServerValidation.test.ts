import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MCP_VALIDATION_CODES,
  hasUnbalancedQuotes,
  validateMcpServerForm,
  validateServerName,
  validateServerUrl,
  validateTimeout,
  type McpServerFormInput,
} from '../mcpServerValidation'

const ctx = { existingNames: ['github', 'notes'], editingKey: null }

const stdio = (over: Partial<McpServerFormInput> = {}): McpServerFormInput => ({
  name: 'files',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem'],
  envKeys: [''],
  envValues: [''],
  url: '',
  headerKeys: [''],
  headerValues: [''],
  timeout: '',
  ...over,
})

const http = (over: Partial<McpServerFormInput> = {}): McpServerFormInput => ({
  ...stdio(),
  transport: 'http',
  command: '',
  args: [''],
  url: 'https://mcp.example.com/mcp',
  ...over,
})

describe('validateServerName', () => {
  it('requires a non-blank name, like the JSON path', () => {
    expect(validateServerName('   ', ctx)?.code).toBe('nameRequired')
  })

  it('rejects a name already in use', () => {
    expect(validateServerName('github', ctx)?.code).toBe('nameDuplicate')
    expect(validateServerName(' github ', ctx)?.code).toBe('nameDuplicate')
  })

  it('lets an edited server keep its own name', () => {
    expect(
      validateServerName('github', { ...ctx, editingKey: 'github' })
    ).toBeNull()
  })

  it('rejects the tool-key separator and control characters', () => {
    expect(validateServerName('a::b', ctx)?.code).toBe('nameInvalidChars')
    expect(validateServerName('a\u0001b', ctx)?.code).toBe('nameInvalidChars')
  })

  it('accepts spaces and punctuation the JSON path accepts', () => {
    expect(validateServerName('Jan Browser MCP', ctx)).toBeNull()
    expect(validateServerName('my-server_2.0', ctx)).toBeNull()
  })
})

describe('validateServerUrl', () => {
  it.each([
    ['', 'urlRequired'],
    ['not a url', 'urlInvalid'],
    ['ftp://example.com', 'urlScheme'],
    ['file:///etc/passwd', 'urlScheme'],
  ])('%s -> %s', (url, code) => {
    expect(validateServerUrl(url)?.code).toBe(code)
  })

  it('accepts http and https', () => {
    expect(validateServerUrl('http://127.0.0.1:3000/mcp')).toBeNull()
    expect(validateServerUrl('https://mcp.example.com')).toBeNull()
  })
})

describe('validateTimeout', () => {
  it('allows empty (use the default)', () => {
    expect(validateTimeout('')).toBeNull()
  })
  it.each(['0', '-5', '1.5', 'abc'])('rejects %s', (value) => {
    expect(validateTimeout(value)?.code).toBe('timeoutInvalid')
  })
  it('accepts a positive integer', () => {
    expect(validateTimeout('30')).toBeNull()
  })
})

describe('hasUnbalancedQuotes', () => {
  it('flags an odd quote count and ignores escaped quotes', () => {
    expect(hasUnbalancedQuotes('"/path/with space')).toBe(true)
    expect(hasUnbalancedQuotes('"/path/with space"')).toBe(false)
    expect(hasUnbalancedQuotes('say \\"hi')).toBe(false)
  })
})

describe('validateMcpServerForm', () => {
  it('passes a complete stdio server', () => {
    const result = validateMcpServerForm(stdio(), ctx)
    expect(result.valid).toBe(true)
    expect(result.firstInvalidField).toBeNull()
  })

  it('requires a command for stdio', () => {
    const result = validateMcpServerForm(stdio({ command: ' ' }), ctx)
    expect(result.errors.command?.code).toBe('commandRequired')
    expect(result.valid).toBe(false)
  })

  it('warns, without blocking, when the command box holds a whole command line', () => {
    const result = validateMcpServerForm(
      stdio({ command: 'npx -y server', args: [''] }),
      ctx
    )
    expect(result.warnings.command?.code).toBe('commandHasSpaces')
    expect(result.valid).toBe(true)
  })

  it('warns on an argument with unbalanced quotes', () => {
    const result = validateMcpServerForm(stdio({ args: ['"/tmp'] }), ctx)
    expect(result.warnings['args.0']?.code).toBe('argUnbalancedQuotes')
    expect(result.valid).toBe(true)
  })

  it('validates environment variable names', () => {
    const result = validateMcpServerForm(
      stdio({
        envKeys: ['GOOD_KEY', '1BAD', 'GOOD_KEY', '', ''],
        envValues: ['x', 'y', 'z', 'orphan', ''],
      }),
      ctx
    )
    expect(result.errors['env.0']).toBeUndefined()
    expect(result.errors['env.1']?.code).toBe('envKeyInvalid')
    expect(result.errors['env.2']?.code).toBe('envKeyDuplicate')
    expect(result.errors['env.3']?.code).toBe('envKeyRequired')
    // The always-present blank row is not an error.
    expect(result.errors['env.4']).toBeUndefined()
  })

  it('ignores stdio-only fields for http and checks the URL instead', () => {
    const result = validateMcpServerForm(http({ url: 'nope' }), ctx)
    expect(result.errors.command).toBeUndefined()
    expect(result.errors.url?.code).toBe('urlInvalid')
  })

  it('validates header names as tokens, case-insensitively unique', () => {
    const result = validateMcpServerForm(
      http({
        headerKeys: ['Authorization', 'bad header', 'authorization'],
        headerValues: ['a', 'b', 'c'],
      }),
      ctx
    )
    expect(result.errors['header.0']).toBeUndefined()
    expect(result.errors['header.1']?.code).toBe('headerNameInvalid')
    expect(result.errors['header.2']?.code).toBe('headerNameDuplicate')
  })

  it('reports the first invalid field in form order', () => {
    const result = validateMcpServerForm(
      http({ name: '', url: '', timeout: '0' }),
      ctx
    )
    expect(result.firstInvalidField).toBe('name')
    const noName = validateMcpServerForm(http({ url: '', timeout: '0' }), ctx)
    expect(noName.firstInvalidField).toBe('url')
  })

  it('has an English message for every code', () => {
    const bundle = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../locales/en/mcp-servers.json'),
        'utf-8'
      )
    )
    for (const code of MCP_VALIDATION_CODES) {
      expect(typeof bundle.validation?.[code], code).toBe('string')
    }
  })
})
