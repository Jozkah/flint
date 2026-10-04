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
}

type PartLike = {
  type?: string
  toolCallId?: string
  input?: unknown
  state?: string
  output?: unknown
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
    const done = part.state === 'output-available' || part.output !== undefined
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
    const { error, body } = parseResult(part.output)
    if (error || !body || body.error) {
      out.push({
        key,
        name: requested,
        sessionId: null,
        status: 'notSent',
        answer: null,
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
