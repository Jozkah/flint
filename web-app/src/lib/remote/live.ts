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
  const isAwaiting = awaiting.has(turn.callId) || turn.toolState === 'awaiting-permission'
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

/** A Cowork run's live lane as one reply: its text so far and its tools. */
export function coworkLiveReply(
  runId: string,
  turns: CoworkTurn[],
  awaiting: ReadonlySet<string> = new Set()
): LiveReply {
  const text = turns
    .filter((t) => t.role === 'assistant' && t.content)
    .map((t) => t.content)
    .join('\n\n')
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
  const textFrom = base && extends_(base.text, next.text) ? base.text.length : 0
  const reasonFrom = base && extends_(base.reasoning, next.reasoning) ? base.reasoning.length : 0
  const textChanged = !base || next.text.length !== textFrom
  const reasonChanged = next.reasoning.length !== reasonFrom
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
  return out
}
