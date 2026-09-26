/**
 * Turn anything thrown or rejected into text a person can act on.
 *
 * `String(e)` renders a plain object as `[object Object]`, and Tauri commands
 * reject with plain objects rather than `Error`s, so that fallback put
 * `Could not be read · [object Object]` on screen wherever a command failed.
 * Everything user-facing goes through here instead.
 */

/** Longest rendering of an otherwise unreadable value. */
const MAX_LENGTH = 400

/** Fields carrying a human-readable message, in the order we prefer them. */
const MESSAGE_KEYS = [
  'message',
  'error',
  'reason',
  'detail',
  'description',
] as const

/**
 * Drop Windows verbatim prefixes (`\\?\C:\…`, `\\?\UNC\server\…`) that
 * canonicalized paths carry into Rust error messages. They are noise to a
 * person and make an ordinary path look alarming.
 */
export const withoutVerbatimPrefix = (value: string): string =>
  value.replace(/\\\\\?\\UNC\\/g, '\\\\').replace(/\\\\\?\\/g, '')

const truncate = (raw: string): string => {
  const value = withoutVerbatimPrefix(raw)
  return value.length > MAX_LENGTH ? `${value.slice(0, MAX_LENGTH - 1)}…` : value
}

/**
 * A readable description of `value`, never `[object Object]` and never empty.
 *
 * `fallback` is used only when the value carries nothing readable at all.
 */
export function errorText(value: unknown, fallback = 'Unknown error'): string {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') return truncate(value.trim() || fallback)
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  if (value instanceof Error) return truncate(value.message.trim() || fallback)

  if (Array.isArray(value)) {
    const parts = value.map((entry) => errorText(entry, '')).filter(Boolean)
    return parts.length ? truncate(parts.join('; ')) : fallback
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    // A nested message wins over the shape of the object around it.
    for (const key of MESSAGE_KEYS) {
      const inner = record[key]
      if (typeof inner === 'string' && inner.trim())
        return truncate(inner.trim())
      if (inner && typeof inner === 'object') {
        const nested = errorText(inner, '')
        if (nested) return truncate(nested)
      }
    }
    // A tagged enum from Rust: `{ NotFound: { path: "..." } }`. The payload's
    // own field names add nothing next to the tag, so only its value is kept.
    const entries = Object.entries(record)
    if (entries.length === 1) {
      const [tag, payload] = entries[0]
      const inner = unwrapSingleValue(payload)
      return truncate(inner ? `${tag}: ${inner}` : tag)
    }
    try {
      const json = JSON.stringify(record)
      if (json && json !== '{}') return truncate(json)
    } catch {
      // Circular or otherwise unserialisable: fall through to the fallback.
    }
    return fallback
  }

  return fallback
}

/**
 * The readable value inside a wrapper, without repeating the wrapper's own
 * field names: `{ path: "/etc/hosts" }` is just the path.
 */
function unwrapSingleValue(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 1) return unwrapSingleValue(entries[0][1])
  }
  return errorText(value, '')
}

/** `errorText` with no fallback text, for building a longer sentence. */
export const errorDetail = (value: unknown): string => errorText(value, '')
