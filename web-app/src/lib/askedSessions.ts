/**
 * What a `send_message` tool call looked like from the sending session: who
 * was asked, and whether an answer came back. Derived from a message's own
 * tool parts, so the transcript can show an "Asked <title>" card without the
 * shared message renderer knowing about session messaging.
 */

export type AskedStatus =
  | 'waiting'
  | 'answered'
  | 'noAnswer'
  | 'sent'
  | 'notSent'

export type AskedSession = {
  /** The tool call id, or the part index when the part has none. */
  key: string
  /** Title the model addressed, replaced by the target's real title when known. */
  name: string
  /** The target session, when the backend resolved it. */
  sessionId: string | null
  status: AskedStatus
  /** The other session's reply text. Untrusted: shown as plain text. */
  answer: string | null
  /** Why a `notSent` call was refused: the backend's error code, if any. */
  reason?: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The model may address a session by raw id. Show that session's title, or a
 * short id when it is unknown, never the full UUID.
 */
export function askedDisplayName(
  raw: string,
  sessions: readonly { id: string; title: string }[]
): string {
  if (!raw || !UUID.test(raw)) return raw
  return sessions.find((s) => s.id === raw)?.title || raw.slice(0, 8)
}

type PartLike = {
  type?: string
  toolCallId?: string
  input?: unknown
  state?: string
  output?: unknown
  errorText?: string
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null

/** A tool result is a JSON string, optionally prefixed `ERROR: `. */
function parseResult(output: unknown): {
  error: boolean
  body: Record<string, unknown> | null
} {
  let text: string | null = null
  if (typeof output === 'string') text = output
  else {
    const rec = asRecord(output)
    if (rec && typeof rec.text === 'string') text = rec.text
    else if (rec) return { error: false, body: rec }
  }
  if (text === null) return { error: false, body: null }
  const trimmed = text.trim()
  const error = trimmed.startsWith('ERROR:')
  const json = error ? trimmed.slice('ERROR:'.length).trim() : trimmed
  try {
    return { error, body: asRecord(JSON.parse(json)) }
  } catch {
    return { error, body: null }
  }
}

export function askedFromParts(parts: PartLike[] | undefined): AskedSession[] {
  if (!parts?.length) return []
  const out: AskedSession[] = []
  parts.forEach((part, index) => {
    if (part.type !== 'tool-send_message') return
    const input = asRecord(part.input)
    const requested =
      (typeof input?.to === 'string' && input.to) ||
      (typeof input?.session_id === 'string' && input.session_id) ||
      ''
    const key = part.toolCallId ?? `part-${index}`
    // A refused call can end as `output-error` with no output (live test
    // 4b): it is finished, not waiting.
    const failed = part.state === 'output-error' || part.errorText !== undefined
    const done =
      failed || part.state === 'output-available' || part.output !== undefined
    if (!done) {
      out.push({
        key,
        name: requested,
        sessionId: null,
        status: 'waiting',
        answer: null,
      })
      return
    }
    const { error, body } = parseResult(
      part.output !== undefined ? part.output : (part.errorText ?? null)
    )
    if (failed || error || !body || body.error) {
      const code = asRecord(body?.error)?.code
      out.push({
        key,
        name: requested,
        sessionId: null,
        status: 'notSent',
        answer: null,
        reason: typeof code === 'string' ? code : null,
      })
      return
    }
    const to = asRecord(body.to)
    const name =
      (typeof to?.display_name === 'string' && to.display_name) || requested
    const sessionId =
      typeof to?.session_id === 'string' ? to.session_id : null
    const reply = asRecord(body.reply)
    const outcome = body.outcome
    let status: AskedStatus = 'sent'
    let answer: string | null = null
    if (outcome === 'reply' && typeof reply?.text === 'string') {
      status = 'answered'
      answer = reply.text
    } else if (typeof outcome === 'string') {
      status = 'noAnswer'
    }
    out.push({ key, name, sessionId, status, answer })
  })
  return out
}
