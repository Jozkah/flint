// A reply being written, as phones follow it: pure extraction from each
// surface's live state (the chat's AI SDK messages, a Cowork run's live
// turns, a room's live turn) and the diff that turns two snapshots into
// `stream.*` events. Stateless, so it is tested with plain data.

import type { UIMessage } from 'ai'
import { toolKind } from '@/lib/toolKind'
import { mainArgOf } from '@/lib/activityDetail'
import type { CoworkTurn } from '@/types/coworkSession'
import { toolOrigin, toolStepsOf } from './details'
import type { RemoteEvent, RemoteToolStep, SessionKind } from './protocol'

export type LiveReply = {
  messageId: string
  text: string
  reasoning: string
  tools: RemoteToolStep[]
  author?: string
}

/** The chat's reply in flight: the last assistant message while the SDK
 * is submitting or streaming; null otherwise. */
export function chatLiveReply(messages: UIMessage[], status: string): LiveReply | null {
  if (status !== 'submitted' && status !== 'streaming') return null
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return null
  let text = ''
  let reasoning = ''
  for (const part of last.parts ?? []) {
    if (part.type === 'text') text += part.text
    else if (part.type === 'reasoning') reasoning += part.text
  }
  return { messageId: last.id, text, reasoning, tools: toolStepsOf(last) }
}

const FAILED_STATES = new Set(['failed', 'refused', 'cancelled', 'stale'])

/** One Cowork tool turn as the phone's timeline row. */
export function coworkToolStep(turn: CoworkTurn, awaiting: ReadonlySet<string>): RemoteToolStep | null {
  if (turn.role !== 'tool' || !turn.callId) return null
  const name = turn.name ?? 'tool'
  const isAwaiting =
    awaiting.has(turn.callId) ||
    turn.toolState === 'awaiting-permission' ||
    // A question the run is waiting on: the call is open until it is answered.
    (name === 'ask' && turn.status !== 'done' && !turn.isError)
  const failed = turn.isError === true || FAILED_STATES.has(turn.toolState ?? '')
  const status: RemoteToolStep['status'] = isAwaiting
    ? 'awaiting'
    : failed
      ? 'failed'
      : turn.status === 'done' || turn.toolState === 'succeeded'
        ? 'done'
        : 'running'
  const arg = mainArgOf(turn.args)
  return {
    id: turn.callId,
    name,
    kind: toolKind({ name, state: failed ? 'output-error' : undefined, awaitingApproval: isAwaiting }),
    status,
    ...(arg ? { arg } : {}),
    origin: toolOrigin(name),
  }
}

const joinText = (turns: CoworkTurn[]) =>
  turns
    .filter((t) => t.role === 'assistant' && t.content)
    .map((t) => t.content)
    .join('\n\n')

// Per run, the joined text of every turn but the last. A streamed delta only
// replaces the last turn, so the earlier text is reused instead of rejoined.
const headCache = new Map<string, { turns: CoworkTurn[]; head: string }>()
const HEAD_CACHE_MAX = 32

function coworkReplyText(runId: string, turns: CoworkTurn[]): string {
  if (turns.length === 0) return ''
  const last = turns.length - 1
  const cached = headCache.get(runId)
  const reuse =
    !!cached &&
    cached.turns.length === turns.length &&
    turns.every((t, i) => i === last || t === cached.turns[i])
  const head = reuse ? cached.head : joinText(turns.slice(0, last))
  headCache.delete(runId)
  if (headCache.size >= HEAD_CACHE_MAX) {
    const oldest = headCache.keys().next().value
    if (oldest !== undefined) headCache.delete(oldest)
  }
  headCache.set(runId, { turns, head })
  const tail = turns[last]
  if (tail.role !== 'assistant' || !tail.content) return head
  return head ? `${head}\n\n${tail.content}` : tail.content
}

/** A Cowork run's live lane as one reply: its text so far and its tools. */
export function coworkLiveReply(
  runId: string,
  turns: CoworkTurn[],
  awaiting: ReadonlySet<string> = new Set()
): LiveReply {
  const text = coworkReplyText(runId, turns)
  const tools = turns.flatMap((t) => {
    const step = coworkToolStep(t, awaiting)
    return step ? [step] : []
  })
  return { messageId: runId, text, reasoning: '', tools }
}

const sameStep = (a: RemoteToolStep, b: RemoteToolStep) =>
  a.status === b.status && a.kind === b.kind && a.arg === b.arg && a.name === b.name

/**
 * The events that take a phone from `prev` to `next` for one conversation.
 * Text is sent as what was appended; when the new text does not extend the
 * old (a rewrite, a new message) it is sent whole from offset 0.
 */
export function diffLiveReply(
  kind: SessionKind,
  id: string,
  prev: LiveReply | null,
  next: LiveReply | null
): RemoteEvent[] {
  const out: RemoteEvent[] = []
  if (prev && (!next || next.messageId !== prev.messageId)) {
    out.push({ type: 'stream.done', kind, id, messageId: prev.messageId })
  }
  if (!next) return out
  const base = prev && prev.messageId === next.messageId ? prev : null
  const extends_ = (a: string, b: string) => b.startsWith(a)
  const textExtends = !!base && extends_(base.text, next.text)
  const reasonExtends = !!base && extends_(base.reasoning, next.reasoning)
  const textFrom = base && textExtends ? base.text.length : 0
  const reasonFrom = base && reasonExtends ? base.reasoning.length : 0
  // A rewrite that does not extend the old value (including a shrink to '')
  // is a change even when nothing is appended.
  const textChanged = !textExtends || next.text.length !== textFrom
  const reasonChanged =
    next.reasoning.length !== reasonFrom || (!!base && !reasonExtends)
  if (textChanged || reasonChanged) {
    out.push({
      type: 'stream.delta',
      kind,
      id,
      messageId: next.messageId,
      offset: textFrom,
      text: next.text.slice(textFrom),
      ...(reasonChanged
        ? { reasoningOffset: reasonFrom, reasoning: next.reasoning.slice(reasonFrom) }
        : {}),
      ...(next.author ? { author: next.author } : {}),
    })
  }
  const before = new Map((base?.tools ?? []).map((s) => [s.id, s]))
  for (const step of next.tools) {
    const old = before.get(step.id)
    if (!old || !sameStep(old, step)) {
      out.push({ type: 'stream.tool', kind, id, messageId: next.messageId, step })
    }
  }
  const after = new Set(next.tools.map((s) => s.id))
  for (const stepId of before.keys()) {
    if (!after.has(stepId)) {
      out.push({ type: 'stream.toolRemoved', kind, id, messageId: next.messageId, stepId })
    }
  }
  return out
}
