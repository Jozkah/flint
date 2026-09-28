// What the phone shows ahead of the computer's stored record: replies being
// written (from `stream.*` events), messages it is sending (optimistic, with
// their real state), and approvals answered while it watched.

import type {
  RemoteEvent,
  RemoteMessage,
  RemoteToolStep,
  SendResult,
  SessionKind,
  StreamSnapshot,
} from '@/lib/remote/protocol'
import { createStore } from './store'

export type LiveStream = {
  kind: SessionKind
  id: string
  messageId: string
  text: string
  reasoning: string
  tools: RemoteToolStep[]
  author?: string
  /** The reply is complete; shown until the stored messages arrive. */
  done: boolean
}

export type PendingStatus = 'sending' | 'sent' | 'queued' | 'steered' | 'failed'

export type PendingSend = {
  clientId: string
  kind: SessionKind
  /** The conversation, or `new` until the computer names it. */
  id: string
  text: string
  status: PendingStatus
  at: number
}

export type Resolution = { by: 'phone' | 'computer'; label: string; threadId?: string }

export type LiveState = {
  streams: Record<string, LiveStream>
  pending: PendingSend[]
  resolved: Record<string, Resolution>
}

export const live = createStore<LiveState>({ streams: {}, pending: [], resolved: {} })
export const useLive = live.use

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/** Text after writing `chunk` at `offset`, or null for a gap (events were
 * missed; the phone must ask for the whole reply). */
export function spliceAt(current: string, offset: number, chunk: string): string | null {
  if (offset > current.length) return null
  return current.slice(0, offset) + chunk
}

export type StreamOutcome = {
  streams: Record<string, LiveStream>
  /** Events were missed for this conversation; fetch `stream.get`. */
  gap?: { kind: SessionKind; id: string }
  /** The reply finished; fetch the stored messages. */
  finished?: { kind: SessionKind; id: string }
}

/** Applies one `stream.*` event. Pure. */
export function applyStreamEvent(
  streams: Record<string, LiveStream>,
  e: RemoteEvent
): StreamOutcome {
  if (e.type !== 'stream.delta' && e.type !== 'stream.tool' && e.type !== 'stream.done') {
    return { streams }
  }
  const cur = streams[e.id]
  const same = cur && cur.messageId === e.messageId
  if (e.type === 'stream.done') {
    if (!same) return { streams, finished: { kind: e.kind, id: e.id } }
    return { streams: { ...streams, [e.id]: { ...cur, done: true } }, finished: { kind: e.kind, id: e.id } }
  }
  const base: LiveStream = same
    ? cur
    : { kind: e.kind, id: e.id, messageId: e.messageId, text: '', reasoning: '', tools: [], done: false }
  if (e.type === 'stream.tool') {
    const i = base.tools.findIndex((s) => s.id === e.step.id)
    const tools = i === -1 ? [...base.tools, e.step] : base.tools.map((s, j) => (j === i ? e.step : s))
    return { streams: { ...streams, [e.id]: { ...base, tools, done: false } } }
  }
  const text = spliceAt(base.text, e.offset, e.text)
  const reasoning =
    e.reasoning !== undefined ? spliceAt(base.reasoning, e.reasoningOffset ?? 0, e.reasoning) : base.reasoning
  if (text === null || reasoning === null) {
    // Keep what is shown; the snapshot fills the rest.
    return { streams: same ? streams : { ...streams, [e.id]: base }, gap: { kind: e.kind, id: e.id } }
  }
  return {
    streams: {
      ...streams,
      [e.id]: { ...base, text, reasoning, done: false, ...(e.author ? { author: e.author } : {}) },
    },
  }
}

export function handleStreamEvent(e: RemoteEvent): StreamOutcome {
  const out = applyStreamEvent(live.get().streams, e)
  if (out.streams !== live.get().streams) live.set({ streams: out.streams })
  return out
}

/** Replaces a conversation's stream with the computer's snapshot. */
export function setSnapshot(id: string, snap: StreamSnapshot | null) {
  live.set((s) => {
    const streams = { ...s.streams }
    if (snap) {
      streams[id] = {
        kind: snap.kind,
        id,
        messageId: snap.messageId,
        text: snap.text,
        reasoning: snap.reasoning,
        tools: snap.tools,
        ...(snap.author ? { author: snap.author } : {}),
        done: false,
      }
    } else if (streams[id] && !streams[id].done) {
      // Nothing in flight any more: the stored messages have it.
      delete streams[id]
    }
    return { streams }
  })
}

export function dropStream(id: string) {
  live.set((s) => {
    if (!s.streams[id]) return {}
    const streams = { ...s.streams }
    delete streams[id]
    return { streams }
  })
}

// ---------------------------------------------------------------------------
// Sends
// ---------------------------------------------------------------------------

let seq = 0
export function newClientId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 12)
  return `m-${Date.now().toString(36)}-${(seq++).toString(36)}-${rand}`
}

export function addPending(p: Omit<PendingSend, 'at' | 'status'>) {
  live.set((s) => ({ pending: [...s.pending, { ...p, status: 'sending', at: Date.now() }] }))
}

export function settlePending(clientId: string, result: SendResult | null) {
  live.set((s) => ({
    pending: s.pending.map((p) =>
      p.clientId === clientId
        ? result
          ? { ...p, id: result.id, status: result.delivery }
          : { ...p, status: 'failed' }
        : p
    ),
  }))
}

export function dropPending(clientId: string) {
  live.set((s) => ({ pending: s.pending.filter((p) => p.clientId !== clientId) }))
}

/** Sends still to show in a conversation: not failed-and-dismissed, and not
 * yet in the stored messages (matched by text, after the send). */
export function pendingFor(
  pending: PendingSend[],
  id: string,
  messages: RemoteMessage[]
): PendingSend[] {
  return pending.filter(
    (p) =>
      p.id === id &&
      !messages.some((m) => m.role === 'user' && m.text.trim() === p.text.trim() && m.createdAt >= p.at - 60_000)
  )
}

/** Forgets sends the stored messages now hold. */
export function prunePending(id: string, messages: RemoteMessage[]) {
  const keep = pendingFor(live.get().pending.filter((p) => p.id === id), id, messages)
  const before = live.get().pending.filter((p) => p.id === id)
  if (keep.length !== before.length) {
    live.set((s) => ({ pending: [...s.pending.filter((p) => p.id !== id), ...keep] }))
  }
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export function markResolved(requestId: string, r: Resolution) {
  live.set((s) => (s.resolved[requestId]?.by === 'phone' ? {} : { resolved: { ...s.resolved, [requestId]: r } }))
}
