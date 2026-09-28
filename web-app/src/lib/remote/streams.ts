// Replies in flight, per conversation: what `stream.get` answers, and the
// `stream.*` events phones follow. Each surface reports its live reply here
// (see `reportLiveReply`); events are coalesced to a few per second so a
// fast model does not become an IPC call per token.

import { diffLiveReply, type LiveReply } from './live'
import { threadTopic, type RemoteEvent, type SessionKind, type StreamSnapshot } from './protocol'

export type StreamSink = (event: RemoteEvent, topic: string) => void

const FLUSH_MS = 120

type Slot = {
  kind: SessionKind
  /** What the surface holds now. */
  current: LiveReply | null
  /** What phones were last told. */
  sent: LiveReply | null
  timer: ReturnType<typeof setTimeout> | null
}

const slots = new Map<string, Slot>()
let sink: StreamSink | null = null

/** Where events go while forwarding is on; null stops sending (snapshots
 * are still kept, so `stream.get` answers). */
export function setStreamSink(next: StreamSink | null) {
  sink = next
  if (!next) {
    for (const slot of slots.values()) {
      if (slot.timer) clearTimeout(slot.timer)
      slot.timer = null
      slot.sent = slot.current
    }
  }
}

function flush(id: string) {
  const slot = slots.get(id)
  if (!slot) return
  if (slot.timer) clearTimeout(slot.timer)
  slot.timer = null
  const events = diffLiveReply(slot.kind, id, slot.sent, slot.current)
  slot.sent = slot.current
  if (!slot.current) slots.delete(id)
  if (sink) for (const e of events) sink(e, threadTopic(id))
}

/** A surface's reply in flight for `id`, or null once it is complete. */
export function reportLiveReply(kind: SessionKind, id: string, reply: LiveReply | null) {
  let slot = slots.get(id)
  if (!slot) {
    if (!reply) return
    slot = { kind, current: null, sent: null, timer: null }
    slots.set(id, slot)
  }
  const changedMessage = slot.current && reply && slot.current.messageId !== reply.messageId
  // An ending (or a new message) first sends what the old one still owed.
  if ((!reply || changedMessage) && slot.current && slot.current !== slot.sent) flush(id)
  slot = slots.get(id) ?? slot
  slot.current = reply
  // Endings, new messages and new tool steps go at once; text coalesces.
  const toolChanged =
    reply && (slot.sent?.tools.length ?? 0) !== reply.tools.length
  if (!reply || changedMessage || toolChanged || !sink) {
    flush(id)
    return
  }
  if (!slot.timer) slot.timer = setTimeout(() => flush(id), FLUSH_MS)
}

/** The reply being written in `id` right now. */
export function streamSnapshot(kind: SessionKind, id: string): StreamSnapshot | null {
  const reply = slots.get(id)?.current
  if (!reply) return null
  return {
    kind,
    id,
    messageId: reply.messageId,
    text: reply.text,
    reasoning: reply.reasoning,
    tools: reply.tools,
    ...(reply.author ? { author: reply.author } : {}),
  }
}

/** Test helper. */
export function resetStreams() {
  for (const slot of slots.values()) if (slot.timer) clearTimeout(slot.timer)
  slots.clear()
  sink = null
}
