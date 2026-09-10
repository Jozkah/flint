/**
 * Tool-call argument coercion.
 *
 * A tool call's arguments are whatever the model emitted, not what the schema
 * asked for. Plenty of local and OpenAI-compatible runtimes serialize every
 * argument value as a JSON string regardless of its declared type, so
 * `{"start_order": 0}` arrives as `{"start_order": "0"}` and `file_ids` arrives
 * as `"[\"abc\"]"`. The Rust vector engine is strictly typed and rejects those
 * with `invalid type: string "0", expected i64`, which fails retrieval for the
 * whole class of runtime rather than for one bad model.
 *
 * These helpers narrow the values back to the declared types at the intake
 * layer, and return undefined — never a guess — for anything that is not
 * recoverable. See janhq/jan#7939.
 */

const INTEGRAL = /^[+-]?\d+(?:\.0+)?$/

/**
 * An integer, from a number or its string spelling. Returns undefined for
 * anything that is not an exact, safe integer: NaN, Infinity, `"6.5"`, `"abc"`,
 * `""`, booleans, objects.
 */
export function coerceIntegerArg(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : undefined
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!INTEGRAL.test(trimmed)) return undefined
    const parsed = Number(trimmed)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * A list of strings, from a real array or from the JSON text of one. A bare
 * string is treated as a single-element list — a model asked for "the file ids"
 * and named one file.
 *
 * Returns undefined when there is nothing usable, so callers can keep their
 * "no filter" behaviour rather than filtering on garbage.
 */
export function coerceStringArrayArg(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string' && v.length > 0)
    return items.length ? items : undefined
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (trimmed.startsWith('[')) {
      try {
        return coerceStringArrayArg(JSON.parse(trimmed))
      } catch {
        return undefined
      }
    }
    return [trimmed]
  }
  return undefined
}
