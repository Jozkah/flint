/**
 * Custom request headers a user configures on a model provider.
 * janhq/jan#8208.
 *
 * One place decides which headers are acceptable and how they combine with
 * the ones Jan sets, so the chat request, model discovery and a key test all
 * send the same thing:
 *
 * - A header Jan owns -- authentication, framing, the dispatch identity -- is
 *   refused. Letting a custom `Authorization` through meant it silently
 *   replaced the configured key on some providers and was sent twice on
 *   others.
 * - Any other header of the same name, whatever its case, is replaced by the
 *   custom one: a user who sets `Anthropic-Version` means it.
 * - A value that is a credential is marked `secret`. It lives in the OS
 *   credential store, never in settings, and is redacted from any text Jan
 *   shows or records.
 */

export const MAX_CUSTOM_HEADERS = 32
export const MAX_HEADER_NAME_LENGTH = 256
export const MAX_HEADER_VALUE_LENGTH = 8192

export type CustomHeaderErrorCode =
  | 'empty-name'
  | 'invalid-name'
  | 'reserved'
  | 'duplicate'
  | 'empty-value'
  | 'invalid-value'
  | 'too-long'
  | 'too-many'

export type CustomHeaderError = { index: number; code: CustomHeaderErrorCode }

type WithHeaders = { custom_header?: ProviderCustomHeader[] | null }

/** RFC 9110 `token`: what a field name may be made of. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * Headers Jan sets itself. Authentication is chosen from the configured keys;
 * the rest frame the request or name it, and a wrong one breaks every call.
 */
const RESERVED = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'accept-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'origin',
])

/** Prefixes Jan or the platform owns. `x-jan-*` carries the dispatch identity. */
const RESERVED_PREFIXES = ['x-jan-', 'proxy-', 'sec-']

export function isReservedHeader(name: string): boolean {
  const lower = name.trim().toLowerCase()
  return (
    RESERVED.has(lower) || RESERVED_PREFIXES.some((p) => lower.startsWith(p))
  )
}

/**
 * Whether a header's name says its value is a credential. Only a default for
 * the editor's switch: the user decides.
 */
export function looksSecret(name: string): boolean {
  return /(auth|token|key|secret|passw|signature|cookie|session|credential|bearer)/i.test(
    name
  )
}

/** CR, LF, NUL and the other controls a value cannot carry; tab is allowed. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if ((c < 32 && c !== 9) || c === 127) return true
  }
  return false
}

function problemWith(
  h: ProviderCustomHeader,
  index: number,
  seen: Set<string>
): CustomHeaderErrorCode | null {
  if (index >= MAX_CUSTOM_HEADERS) return 'too-many'
  const name = (h.header ?? '').trim()
  if (!name) return 'empty-name'
  if (name.length > MAX_HEADER_NAME_LENGTH) return 'too-long'
  if (!TOKEN.test(name)) return 'invalid-name'
  if (isReservedHeader(name)) return 'reserved'
  const lower = name.toLowerCase()
  if (seen.has(lower)) return 'duplicate'
  seen.add(lower)
  const value = h.value ?? ''
  if (value.length > MAX_HEADER_VALUE_LENGTH) return 'too-long'
  if (hasControlCharacter(value)) return 'invalid-value'
  // Secret rows too: one still blank because its value could not be loaded
  // has nothing to send, and saving it would look like it had.
  if (!value.trim()) return 'empty-value'
  return null
}

/** Every problem, one per row, in row order. Empty when all rows are sound. */
export function validateCustomHeaders(
  rows: ProviderCustomHeader[]
): CustomHeaderError[] {
  const seen = new Set<string>()
  const errors: CustomHeaderError[] = []
  rows.forEach((h, index) => {
    const code = problemWith(h, index, seen)
    if (code) errors.push({ index, code })
  })
  return errors
}

/** The rows that may be sent: sound, and with a value to send. */
function sendable(provider: WithHeaders): ProviderCustomHeader[] {
  const rows = provider.custom_header ?? []
  const seen = new Set<string>()
  return rows.filter(
    (h, index) => problemWith(h, index, seen) === null && h.value.trim() !== ''
  )
}

/**
 * Add a provider's custom headers to `headers`, in place, and return it.
 *
 * Call after the built-in defaults and before authentication is set, or with
 * authentication already present: reserved names are never written, so the
 * configured key cannot be replaced either way.
 */
export function applyCustomHeaders(
  headers: Record<string, string>,
  provider: WithHeaders
): Record<string, string> {
  for (const h of sendable(provider)) {
    const name = h.header.trim()
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing]
    }
    headers[name] = h.value.trim()
  }
  return headers
}

/** The rows as they may be written to settings: secret values removed. */
export function withoutSecretValues(
  rows: ProviderCustomHeader[]
): ProviderCustomHeader[] {
  return rows.map((h) => (h.secret ? { ...h, value: '' } : h))
}

/** The secret values of a provider's headers, longest first. */
export function secretHeaderValues(provider: WithHeaders): string[] {
  return (provider.custom_header ?? [])
    .filter((h) => h.secret && h.value.trim().length >= 4)
    .map((h) => h.value.trim())
    .sort((a, b) => b.length - a.length)
}

/**
 * Replace every secret header value in `text` with `<redacted>`. For an error
 * that may echo the request back before it is shown or recorded.
 */
export function redactCustomHeaderValues(
  text: string,
  provider: WithHeaders
): string {
  let out = text
  for (const value of secretHeaderValues(provider)) {
    out = out.split(value).join('<redacted>')
  }
  return out
}
