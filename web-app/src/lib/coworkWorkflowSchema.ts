/**
 * Typed results for `workflow` agents.
 *
 * An agent may carry a JSON schema. Its answer is parsed, checked against the
 * schema, and sent back for another try (with what was wrong) a bounded number
 * of times. Later phases then receive the parsed JSON, not whatever prose
 * wrapped it. Covers the schema keywords models actually write: `type`,
 * `properties`, `required`, `additionalProperties`, `items`, `enum`.
 */

/** Attempts per agent, the first included. */
export const MAX_SCHEMA_ATTEMPTS = 5

const MAX_SCHEMA_CHARS = 8_000
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

type Schema = Record<string, unknown>
const isObject = (v: unknown): v is Schema =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** A sentence naming what is wrong with the schema itself, or `null`. */
export function schemaProblem(schema: unknown, at = 'schema'): string | null {
  if (!isObject(schema)) return `${at} must be a JSON schema object`
  if (at === 'schema' && JSON.stringify(schema).length > MAX_SCHEMA_CHARS) {
    return `${at} is longer than ${MAX_SCHEMA_CHARS} characters`
  }
  if (schema.type !== undefined && (typeof schema.type !== 'string' || !TYPES.has(schema.type))) {
    return `${at}.type must be one of ${[...TYPES].join(', ')}`
  }
  const required = schema.required
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((k) => typeof k !== 'string')) {
      return `${at}.required must be an array of strings`
    }
    const props = isObject(schema.properties) ? schema.properties : {}
    if (schema.additionalProperties === false) {
      const missing = (required as string[]).find((k) => !(k in props))
      if (missing !== undefined) {
        return `${at} contradicts itself: '${missing}' is required but additionalProperties:false allows only the listed properties`
      }
    }
  }
  if (isObject(schema.properties)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      const problem = schemaProblem(sub, `${at}.properties.${key}`)
      if (problem) return problem
    }
  }
  if (schema.items !== undefined) return schemaProblem(schema.items, `${at}.items`)
  return null
}

/** The first way `value` breaks `schema`, or `null` when it fits. */
export function validateAgainst(schema: Schema, value: unknown, at = '$'): string | null {
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    return `${at} must be one of ${JSON.stringify(schema.enum)}`
  }
  const type = schema.type as string | undefined
  const actual =
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (type) {
    const ok =
      type === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : actual === type
    if (!ok) return `${at} must be ${type}, got ${actual}`
  }
  if (isObject(value)) {
    const props = isObject(schema.properties) ? schema.properties : {}
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        return `${at}.${key} is required`
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        const problem = validateAgainst(props[key] as Schema, item, `${at}.${key}`)
        if (problem) return problem
      } else if (schema.additionalProperties === false) {
        return `${at}.${key} is not allowed`
      }
    }
  }
  if (Array.isArray(value) && isObject(schema.items)) {
    for (const [i, item] of value.entries()) {
      const problem = validateAgainst(schema.items, item, `${at}[${i}]`)
      if (problem) return problem
    }
  }
  return null
}

/** The JSON in an answer: the whole text, a fenced block, or the first {..}/[..]. */
export function extractJson(text: string): { value: unknown } | null {
  const candidates = [text.trim()]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced) candidates.push(fenced[1].trim())
  for (const open of ['{', '[']) {
    const start = text.indexOf(open)
    const end = text.lastIndexOf(open === '{' ? '}' : ']')
    if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  }
  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate) }
    } catch {
      /* next */
    }
  }
  return null
}

/** What an agent with a schema is told about its answer. */
export function schemaInstruction(schema: Schema): string {
  return (
    '\n\nReply with ONLY one JSON value matching this JSON Schema, no prose and no code fence:\n' +
    JSON.stringify(schema)
  )
}

export type TypedOutcome = { ok: boolean; output: string; isError?: boolean }

/**
 * Run an agent until its answer fits `schema`, at most `max` times. `run`
 * gets the brief for that attempt; a run that itself failed is returned as is,
 * since asking again would not fix it. On success `output` is the parsed value
 * as compact JSON.
 */
export async function runTyped(
  description: string,
  schema: Schema,
  run: (brief: string, attempt: number) => Promise<{ output: string; isError?: boolean }>,
  max = MAX_SCHEMA_ATTEMPTS
): Promise<TypedOutcome & { attempts: number }> {
  let brief = description
  let problem = ''
  for (let attempt = 1; attempt <= max; attempt++) {
    const result = await run(brief, attempt)
    if (result.isError) return { ok: false, ...result, attempts: attempt }
    const found = extractJson(result.output)
    problem = found
      ? (validateAgainst(schema, found.value) ?? '')
      : 'the answer contained no JSON'
    if (found && !problem) {
      return { ok: true, output: JSON.stringify(found.value), attempts: attempt }
    }
    brief =
      `${description}\n\nYour previous answer was rejected: ${problem}. ` +
      'Reply again with ONLY the corrected JSON value.'
  }
  return {
    ok: false,
    isError: true,
    output: `the agent's answer did not match its schema after ${max} attempts: ${problem}`,
    attempts: max,
  }
}
