/**
 * Take credentials out of the Cowork session store before it is written.
 *
 * Cowork keeps the live history in memory, where the model needs the raw tool
 * output, and persists the whole session list to settings.json. That persisted
 * copy held every tool call's arguments and result verbatim: `redactToolOutput`
 * was only wired into the thread chat. So the redaction is applied at the one
 * place everything is written, as the value goes to the backend, and only to
 * the copy on disk.
 *
 * The rules are the shared Rust ones (`secretsRedact`); nothing is reimplemented
 * here. A string the redactor cannot check becomes `UNREDACTABLE`, never the
 * original (see `redactToolOutput`).
 */

import type { StateStorage } from 'zustand/middleware'
import { redactText, UNREDACTABLE } from '@/lib/redactToolOutput'

/** Below this a string cannot hold a credential worth the round trip. */
const MIN_LENGTH = 8
const CACHE_LIMIT = 4000

type Rec = Record<string, unknown>

// Results are pure, and persist fires on every store change while a run
// streams: the same output must not cross IPC again on each write.
const cache = new Map<string, string>()

function isRec(value: unknown): value is Rec {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return value.length >= MIN_LENGTH ? fn(value) : value
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn))
  if (isRec(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])
    )
  }
  return value
}

/** Apply `fn` to the strings of every persisted tool call and result. */
function mapSessionStrings(session: Rec, fn: (s: string) => string): Rec {
  const mapMessage = (message: unknown): unknown => {
    if (!isRec(message) || !Array.isArray(message.parts)) return message
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (!isRec(part) || typeof part.type !== 'string') return part
        if (part.type !== 'dynamic-tool' && !part.type.startsWith('tool-')) {
          return part
        }
        const next: Rec = { ...part }
        for (const key of ['input', 'output', 'errorText']) {
          if (key in next) next[key] = mapStrings(next[key], fn)
        }
        return next
      }),
    }
  }
  const mapTurns = (turns: unknown): unknown => {
    if (!Array.isArray(turns)) return turns
    return turns.map((turn) => {
      if (!isRec(turn) || turn.role !== 'tool') return turn
      const next: Rec = { ...turn }
      for (const key of ['args', 'result', 'content', 'argsLive']) {
        if (key in next) next[key] = mapStrings(next[key], fn)
      }
      return next
    })
  }

  const out: Rec = { ...session }
  if (Array.isArray(out.messages)) out.messages = out.messages.map(mapMessage)
  if ('turns' in out) out.turns = mapTurns(out.turns)
  if (isRec(out.inFlight) && 'turns' in out.inFlight) {
    out.inFlight = { ...out.inFlight, turns: mapTurns(out.inFlight.turns) }
  }
  if (Array.isArray(out.subagents)) {
    out.subagents = out.subagents.map((run) =>
      isRec(run) && 'turns' in run ? { ...run, turns: mapTurns(run.turns) } : run
    )
  }
  return out
}

/**
 * Redact the serialized `{ state: { sessions } }` blob. Anything that is not
 * that shape is returned as it came: it is the store's own serialization, so
 * a different shape holds no session to check.
 */
export async function redactPersistedSessions(raw: string): Promise<string> {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!isRec(doc) || !isRec(doc.state) || !Array.isArray(doc.state.sessions)) {
    return raw
  }
  const sessions = doc.state.sessions as unknown[]

  if (cache.size > CACHE_LIMIT) cache.clear()
  // This call's own results: a concurrent call may clear the shared cache
  // while these redactions are awaited, and a string missing from it would
  // be written as UNREDACTABLE instead of its redacted form.
  const local = new Map<string, string>()
  const wanted = new Set<string>()
  for (const session of sessions) {
    if (isRec(session)) {
      mapSessionStrings(session, (s) => {
        const hit = cache.get(s)
        if (hit === undefined) wanted.add(s)
        else local.set(s, hit)
        return s
      })
    }
  }
  if (wanted.size > 0) {
    await Promise.all(
      [...wanted].map(async (s) => {
        const redacted = await redactText(s)
        local.set(s, redacted)
        cache.set(s, redacted)
      })
    )
  }
  const next = sessions.map((session) =>
    isRec(session)
      ? mapSessionStrings(
          session,
          (s) => local.get(s) ?? cache.get(s) ?? UNREDACTABLE
        )
      : session
  )
  return JSON.stringify({ ...doc, state: { ...doc.state, sessions: next } })
}

/** A `StateStorage` that redacts sessions on their way to `inner`. */
export function redactingSessionStorage(inner: StateStorage): StateStorage {
  return {
    getItem: (name) => inner.getItem(name),
    removeItem: (name) => inner.removeItem(name),
    setItem: async (name, value) => {
      await inner.setItem(name, await redactPersistedSessions(value))
    },
  }
}
