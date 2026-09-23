/**
 * The one shared, conservative recovery for tool-call argument text the model
 * streamed. Every execution path that recovers a parse-failure goes through
 * `recoverToolArgs` -- Cowork's own loop (`consumeStep`), the SDK repair hook
 * that Chat, Rooms and the main Cowork share (`experimental_repairToolCall`),
 * and subagents (which fall back to `consumeStep`). There is deliberately no
 * second implementation: the trailing-brace, `{}{}` and bad-escape cases all
 * reduce to the same rules here.
 *
 * Conservative on purpose. It recovers exactly one complete leading JSON object
 * and only when everything after it is harmless (whitespace, or a run of
 * unmatched trailing `}` that a model tacked on). Anything else -- a second
 * real object, truncated JSON, an array, a primitive, a value whose inside is
 * malformed, text that isn't JSON -- is left to the caller to refuse. A
 * recovery that "helped" by guessing is worse than a clean refusal: it would
 * run a tool with invented arguments.
 */

const HEX = /[0-9a-fA-F]/

/**
 * Re-escapes backslashes inside JSON string literals as literal path
 * separators. Small local models emit Windows paths like `C:\Users\name\file.txt`
 * verbatim, where `\U`, `\n`, `\f`, ... are treated as (invalid or unintended)
 * JSON escapes and the path is corrupted or dropped. Every backslash is doubled
 * except a genuine `\uXXXX` unicode escape, which is preserved. Run it only on
 * text that already failed to parse (see `recoverToolArgs`, which parses first),
 * so an intended escape in valid JSON is never mangled.
 */
export function sanitizeInvalidJsonEscapes(raw: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (!inString) {
      if (ch === '"') inString = true
      out += ch
      continue
    }
    if (ch === '\\') {
      const isUnicode =
        raw[i + 1] === 'u' &&
        HEX.test(raw[i + 2] ?? '') &&
        HEX.test(raw[i + 3] ?? '') &&
        HEX.test(raw[i + 4] ?? '') &&
        HEX.test(raw[i + 5] ?? '')
      if (isUnicode) {
        out += raw.slice(i, i + 6)
        i += 5
      } else {
        out += '\\\\'
      }
      continue
    }
    if (ch === '"') inString = false
    out += ch
  }
  return out
}

/**
 * The text of the first complete top-level JSON object in `text`, found by a
 * quote/escape-aware brace-depth scan, or undefined when the braces never
 * balance (a truncated object). Braces inside string literals -- including a
 * path or a snippet of code the model put in a `content` field -- do not count.
 */
export function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return undefined
}

/** Parse `s` into a plain object, or undefined for non-object / unparseable. */
function asPlainObject(s: string): Record<string, unknown> | undefined {
  for (const candidate of [s, sanitizeInvalidJsonEscapes(s)]) {
    try {
      const v = JSON.parse(candidate)
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        return v as Record<string, unknown>
      }
    } catch {
      // try the escape-repaired spelling next
    }
  }
  return undefined
}

/**
 * Recover a tool call's arguments object from raw streamed text.
 *
 * Returns the parsed object, or undefined when nothing usable is present so the
 * caller keeps refusing. The order of attempts is from most to least aggressive:
 *  1. parse the whole text as-is (the common, well-formed case -- returned
 *     unchanged, so valid paths/escapes are never touched);
 *  2. parse the whole text after re-escaping bad backslashes (the Windows-path
 *     case);
 *  3. take the first complete leading object and accept it ONLY when the
 *     remainder is whitespace plus a run of unmatched trailing `}` (the stray
 *     brace case, e.g. `{"path":"…"}}`).
 *
 * Case 3 is what keeps `{}{}` and `{"a":1}{"b":2}` refused: their remainder is
 * another real object, not trailing junk, so no object is returned and the call
 * is refused as a whole.
 */
export function recoverToolArgs(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string') {
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined
  }
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  // 1 + 2: the whole text is one object (plain, or after escape repair).
  const whole = asPlainObject(trimmed)
  if (whole) return whole

  // 3: exactly one complete leading object, nothing but harmless trailing junk.
  const first = firstJsonObject(trimmed)
  if (!first) return undefined
  const rest = trimmed.slice(first.length)
  if (!/^[}\s]*$/.test(rest)) return undefined
  return asPlainObject(first)
}

/**
 * Thin, backward-compatible name for `recoverToolArgs` for the Chat repair hook
 * and its tests. Same conservative rules, `null` instead of `undefined`.
 */
export function repairToolArgs(raw: string): Record<string, unknown> | null {
  return recoverToolArgs(raw) ?? null
}
