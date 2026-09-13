/**
 * Validation for the MCP server form (Settings > MCP Servers > Add / Edit).
 *
 * The JSON path in the same dialog only checks that a server name is non-empty
 * and that `type` is one of the known transports; the form path had no checks at
 * all, so a server with no command or an unparseable URL was saved, enabled, and
 * then failed to start with an error far from the field that caused it. This
 * keeps the name rule identical to the JSON path (trimmed, non-empty) and adds
 * the field-level checks the form can make before anything is started.
 *
 * Pure: no React, no i18n. Each issue carries a stable `code`; the dialog maps
 * codes to strings under `mcp-servers:validation.*`.
 */

export type McpTransport = 'stdio' | 'http' | 'sse'

export type McpServerFormInput = {
  name: string
  transport: McpTransport
  command: string
  args: string[]
  envKeys: string[]
  envValues: string[]
  url: string
  headerKeys: string[]
  headerValues: string[]
  timeout: string
}

export type McpValidationContext = {
  /** Names of servers already configured. */
  existingNames: string[]
  /** The name being edited, which is allowed to keep its own name. */
  editingKey: string | null
}

export type McpValidationCode =
  | 'nameRequired'
  | 'nameDuplicate'
  | 'nameInvalidChars'
  | 'commandRequired'
  | 'commandHasSpaces'
  | 'argUnbalancedQuotes'
  | 'urlRequired'
  | 'urlInvalid'
  | 'urlScheme'
  | 'timeoutInvalid'
  | 'headerNameRequired'
  | 'headerNameInvalid'
  | 'headerNameDuplicate'
  | 'envKeyRequired'
  | 'envKeyInvalid'
  | 'envKeyDuplicate'

/** Every code, so tests can assert each one has a message. */
export const MCP_VALIDATION_CODES: readonly McpValidationCode[] = [
  'nameRequired',
  'nameDuplicate',
  'nameInvalidChars',
  'commandRequired',
  'commandHasSpaces',
  'argUnbalancedQuotes',
  'urlRequired',
  'urlInvalid',
  'urlScheme',
  'timeoutInvalid',
  'headerNameRequired',
  'headerNameInvalid',
  'headerNameDuplicate',
  'envKeyRequired',
  'envKeyInvalid',
  'envKeyDuplicate',
]

export type McpValidationIssue = {
  code: McpValidationCode
  severity: 'error' | 'warning'
}

/**
 * Field identifiers, in the order the fields appear in the form. `args.N`,
 * `env.N` and `header.N` address one row of a repeating group.
 */
export type McpFieldId =
  | 'name'
  | 'command'
  | 'url'
  | 'timeout'
  | `args.${number}`
  | `env.${number}`
  | `header.${number}`

export type McpValidationResult = {
  /** Blocking problems, keyed by field. At most one per field. */
  errors: Partial<Record<McpFieldId, McpValidationIssue>>
  /** Non-blocking notes, keyed by field. At most one per field. */
  warnings: Partial<Record<McpFieldId, McpValidationIssue>>
  valid: boolean
  /** The first field with an error, in form order, for focus management. */
  firstInvalidField: McpFieldId | null
}

/**
 * Tool keys are built as `<server>::<tool>` (see `createToolKey`), so a server
 * name containing `::` would make its tool keys ambiguous. Control characters
 * cannot be typed meaningfully and break the config file's readability.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const TOOL_KEY_SEPARATOR = '::'

/** RFC 9110 `token`: the characters a header field name may contain. */
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** POSIX-portable environment variable name. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

const error = (code: McpValidationCode): McpValidationIssue => ({
  code,
  severity: 'error',
})
const warning = (code: McpValidationCode): McpValidationIssue => ({
  code,
  severity: 'warning',
})

/**
 * Whether a single argument has an odd number of unescaped quotes of either
 * kind. Arguments are passed to the program as-is (no shell), so a stray quote
 * usually means a value was pasted from a shell command line. A warning only:
 * a literal apostrophe is legitimate.
 */
export function hasUnbalancedQuotes(arg: string): boolean {
  let double = 0
  let single = 0
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '"') double++
    else if (ch === "'") single++
  }
  return double % 2 === 1 || single % 2 === 1
}

export function validateServerName(
  rawName: string,
  ctx: McpValidationContext
): McpValidationIssue | null {
  const name = rawName.trim()
  if (!name) return error('nameRequired')
  if (CONTROL_CHARS.test(name) || name.includes(TOOL_KEY_SEPARATOR)) {
    return error('nameInvalidChars')
  }
  const taken = ctx.existingNames.some(
    (existing) => existing === name && existing !== ctx.editingKey
  )
  if (taken) return error('nameDuplicate')
  return null
}

export function validateServerUrl(rawUrl: string): McpValidationIssue | null {
  const url = rawUrl.trim()
  if (!url) return error('urlRequired')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return error('urlInvalid')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return error('urlScheme')
  }
  return null
}

export function validateTimeout(rawTimeout: string): McpValidationIssue | null {
  const timeout = rawTimeout.trim()
  if (timeout === '') return null
  if (!/^\d+$/.test(timeout) || Number(timeout) <= 0) {
    return error('timeoutInvalid')
  }
  return null
}

/**
 * Validate one key/value group (env vars or headers). A row whose key and value
 * are both empty is the blank row the form always shows, not a mistake.
 */
function validatePairs(
  keys: string[],
  values: string[],
  pattern: RegExp,
  codes: {
    required: McpValidationCode
    invalid: McpValidationCode
    duplicate: McpValidationCode
  },
  caseInsensitive: boolean
): Map<number, McpValidationIssue> {
  const issues = new Map<number, McpValidationIssue>()
  const seen = new Set<string>()
  keys.forEach((rawKey, index) => {
    const key = rawKey.trim()
    const value = (values[index] ?? '').trim()
    if (!key) {
      if (value) issues.set(index, error(codes.required))
      return
    }
    if (!pattern.test(key)) {
      issues.set(index, error(codes.invalid))
      return
    }
    const normalized = caseInsensitive ? key.toLowerCase() : key
    if (seen.has(normalized)) {
      issues.set(index, error(codes.duplicate))
      return
    }
    seen.add(normalized)
  })
  return issues
}

export function validateMcpServerForm(
  input: McpServerFormInput,
  ctx: McpValidationContext
): McpValidationResult {
  const errors: McpValidationResult['errors'] = {}
  const warnings: McpValidationResult['warnings'] = {}
  const order: McpFieldId[] = []

  const nameIssue = validateServerName(input.name, ctx)
  order.push('name')
  if (nameIssue) errors.name = nameIssue

  if (input.transport === 'stdio') {
    order.push('command')
    const command = input.command.trim()
    if (!command) {
      errors.command = error('commandRequired')
    } else if (/\s/.test(command) && input.args.every((a) => !a.trim())) {
      // "npx -y some-server" typed into the command box: the whole string is
      // looked up as one program name and the start fails with "not found".
      warnings.command = warning('commandHasSpaces')
    }

    input.args.forEach((arg, index) => {
      const id: McpFieldId = `args.${index}`
      order.push(id)
      if (hasUnbalancedQuotes(arg)) warnings[id] = warning('argUnbalancedQuotes')
    })

    const envIssues = validatePairs(
      input.envKeys,
      input.envValues,
      ENV_KEY,
      {
        required: 'envKeyRequired',
        invalid: 'envKeyInvalid',
        duplicate: 'envKeyDuplicate',
      },
      false
    )
    input.envKeys.forEach((_, index) => {
      const id: McpFieldId = `env.${index}`
      order.push(id)
      const issue = envIssues.get(index)
      if (issue) errors[id] = issue
    })
  } else {
    order.push('url')
    const urlIssue = validateServerUrl(input.url)
    if (urlIssue) errors.url = urlIssue

    const headerIssues = validatePairs(
      input.headerKeys,
      input.headerValues,
      HEADER_TOKEN,
      {
        required: 'headerNameRequired',
        invalid: 'headerNameInvalid',
        duplicate: 'headerNameDuplicate',
      },
      // Header names are case-insensitive on the wire.
      true
    )
    input.headerKeys.forEach((_, index) => {
      const id: McpFieldId = `header.${index}`
      order.push(id)
      const issue = headerIssues.get(index)
      if (issue) errors[id] = issue
    })

    order.push('timeout')
    const timeoutIssue = validateTimeout(input.timeout)
    if (timeoutIssue) errors.timeout = timeoutIssue
  }

  const firstInvalidField = order.find((id) => errors[id]) ?? null
  return {
    errors,
    warnings,
    valid: firstInvalidField === null,
    firstInvalidField,
  }
}
