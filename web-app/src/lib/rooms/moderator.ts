/**
 * Moderator prompt and lenient directive parsing (docs/DISCUSSION_ROOMS.md,
 * "moderator-selected"). A directive can only choose a speaker, pass a
 * request, record disagreements or close the room. It never changes settings.
 */
import { activeParticipants } from './policy'
import type { ModeratorDirective, Room } from './types'

export function moderatorInstruction(room: Room): string {
  const names = activeParticipants(room)
    .map((p) => `"${p.name}"`)
    .join(', ')
  return [
    'You are moderating this discussion. Do not take a position yourself.',
    `Choose who should speak next from: ${names}.`,
    'Reply with only a JSON object, no other text:',
    '{"next": "<participant name>", "request": "<optional targeted question for that speaker or null>", "disagreements": ["<open disagreement>"], "converged": false, "stop": false, "reason": "<one sentence>"}',
    'Set "converged" to true when the participants have reached agreement or are no longer adding anything new. Set "stop" to true only if the discussion cannot usefully continue.',
  ].join('\n')
}

function stripFences(raw: string): string {
  const fence = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  return fence ? fence[1] : raw
}

/** The first balanced `{...}` object in the text, ignoring braces in strings. */
export function extractJsonObject(raw: string): string | null {
  const text = stripFences(raw)
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true'
  return false
}

function asText(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim()
    return t && t.toLowerCase() !== 'null' ? t : null
  }
  if (typeof v === 'number') return String(v)
  return null
}

const KNOWN_KEYS = ['next', 'request', 'disagreements', 'converged', 'stop', 'reason']

/** Parse a directive leniently; null when nothing usable was produced. */
export function parseDirective(raw: string): ModeratorDirective | null {
  const json = extractJsonObject(raw ?? '')
  if (!json) return null
  let obj: unknown
  try {
    obj = JSON.parse(json)
  } catch {
    try {
      // Common slip: trailing commas.
      obj = JSON.parse(json.replace(/,\s*([}\]])/g, '$1'))
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  if (!KNOWN_KEYS.some((k) => k in o)) return null

  let disagreements: string[] = []
  if (Array.isArray(o.disagreements)) {
    disagreements = o.disagreements
      .map((d) => asText(d))
      .filter((d): d is string => !!d)
      .map((d) => d.slice(0, 500))
      .slice(0, 20)
  } else {
    const single = asText(o.disagreements)
    if (single) disagreements = [single.slice(0, 500)]
  }

  return {
    next: asText(o.next)?.slice(0, 200) ?? null,
    request: asText(o.request)?.slice(0, 2000) ?? null,
    disagreements,
    converged: asBool(o.converged),
    stop: asBool(o.stop),
    reason: (asText(o.reason) ?? '').slice(0, 1000),
  }
}

/** Readable text for the `moderator-note` that records a directive. */
export function renderDirective(d: ModeratorDirective, nextName: string | null): string {
  const lines: string[] = []
  if (d.converged) lines.push('The moderator judged that the discussion has converged.')
  else if (d.stop) lines.push('The moderator closed the discussion.')
  else if (nextName) lines.push(`Next: ${nextName}.`)
  if (d.request) lines.push(`Request: ${d.request}`)
  if (d.disagreements.length) {
    lines.push('Open disagreements:')
    for (const x of d.disagreements) lines.push(`- ${x}`)
  }
  if (d.reason) lines.push(`Reason: ${d.reason}`)
  return lines.join('\n') || 'The moderator gave no details.'
}
