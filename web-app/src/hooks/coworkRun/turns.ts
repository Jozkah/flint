// Pure turn-lane updates the Cowork run store applies: streamed tokens, tool
// calls and results, asks, prompt snapshots and subagent events.

import type { AskAnswer, AskRecord, CoworkTurn } from '@/types/coworkSession'
import type { StreamEvent } from './types'

// Append a streamed token to the last assistant turn, or start a new one.
// Shared by the main stream (appendToken) and a subagent's wrapped stream
// (applyInnerToTurns) — same merge, different turn lane.
export function appendAssistantToken(turns: CoworkTurn[], text: string): CoworkTurn[] {
  const last = turns[turns.length - 1]
  if (last && last.role === 'assistant')
    return [...turns.slice(0, -1), { ...last, content: last.content + text }]
  return [...turns, { role: 'assistant', content: text }]
}

// A freshly-dispatched tool call's turn. Shared by the main stream's
// pushToolTurn call site (cowork.tsx) and a subagent's wrapped tool_call.
export function makeToolCallTurn(ev: {
  id: string
  name: string
  args: unknown
}): CoworkTurn {
  return {
    role: 'tool',
    content: '',
    callId: ev.id,
    name: ev.name,
    args: ev.args,
    status: 'running',
    // The durable item begins here and is never replaced: the result merges
    // onto this same turn.
    toolState: 'running',
    startedAt: Date.now(),
  }
}

/**
 * Which terminal state an error result belongs in.
 *
 * A refusal and a cancellation are not failures -- they are outcomes the user
 * or the permission gate chose -- and the timeline has to keep saying which,
 * because "failed" would read as the tool having gone wrong.
 */
export function toolOutcome(
  isError: boolean,
  content: string
): 'succeeded' | 'failed' | 'cancelled' | 'refused' {
  if (!isError) return 'succeeded'
  const text = content.toLowerCase()
  if (text.includes('cancelled') || text.includes('canceled') || text.includes('interrupted')) {
    return 'cancelled'
  }
  if (
    text.includes('refused') ||
    text.includes('denied') ||
    text.includes('not permitted') ||
    text.includes('permission')
  ) {
    return 'refused'
  }
  return 'failed'
}

// Find the tool turn by callId and merge patch onto it; returns the same
// array reference (no-op) when there's no match, so callers can cheaply
// detect "nothing changed". Shared by updateToolTurn and applyInnerToTurns.
export function mergeToolResult(
  turns: CoworkTurn[],
  callId: string,
  patch: Partial<CoworkTurn>
): CoworkTurn[] {
  const idx = turns.findIndex((tn) => tn.role === 'tool' && tn.callId === callId)
  if (idx === -1) return turns
  return [...turns.slice(0, idx), { ...turns[idx], ...patch }, ...turns.slice(idx + 1)]
}

/**
 * Put a question on the assistant turn that was speaking when it was asked.
 *
 * Pure, because there are two live-turn lanes: this store, and the Cowork
 * route's own ref-backed copy that it actually renders. Both have to apply the
 * same rule, and a rule that lives in one store action is a rule the other
 * lane silently does not have.
 */
/**
 * The row a question was hung on, for a row that is a copy made to hold it.
 * A run's settling step drops the rows it streamed by identity; without this
 * the copy survived next to the settled row and its text showed twice.
 */
const askCopies = new WeakMap<CoworkTurn, CoworkTurn>()

/** The row `turn` was copied from to carry a question, if it was. */
export function askCopyOrigin(turn: CoworkTurn): CoworkTurn | undefined {
  return askCopies.get(turn)
}

function copyForAsk(turn: CoworkTurn, next: CoworkTurn): CoworkTurn {
  askCopies.set(next, askCopies.get(turn) ?? turn)
  return next
}

export function attachAskToTurns(
  turns: CoworkTurn[],
  record: AskRecord
): CoworkTurn[] {
  if (turns.some((t) => t.asks?.some((a) => a.requestId === record.requestId))) {
    return turns
  }
  // The assistant turn, not the tool turn: a tool turn is the call itself, and
  // hanging the card off it would put the question inside the tool card.
  let idx = -1
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant') {
      idx = i
      break
    }
  }
  if (idx === -1) {
    return [...turns, { role: 'assistant', content: '', asks: [record] }]
  }
  return [
    ...turns.slice(0, idx),
    copyForAsk(turns[idx], {
      ...turns[idx],
      asks: [...(turns[idx].asks ?? []), record],
    }),
    ...turns.slice(idx + 1),
  ]
}

/** Record what became of a question, in place, without moving it. */
export function settleAskInTurns(
  turns: CoworkTurn[],
  requestId: string,
  state: AskRecord['state'],
  answers?: AskAnswer[]
): CoworkTurn[] {
  let changed = false
  const next = turns.map((turn) => {
    if (!turn.asks?.some((a) => a.requestId === requestId)) return turn
    changed = true
    return copyForAsk(turn, {
      ...turn,
      asks: turn.asks.map((a) =>
        a.requestId === requestId ? { ...a, state, answers } : a
      ),
    })
  })
  return changed ? next : turns
}

/**
 * Put a prompt snapshot on the turn whose reply that request produced.
 *
 * The dispatch happens before the reply streams, so the turn it belongs to is
 * the open assistant turn -- or a new one, which the reply is then appended to.
 */
export function attachPromptSnapshotToTurns(
  turns: CoworkTurn[],
  ref: { id: string; hash: string; redactions: number }
): CoworkTurn[] {
  if (turns.some((t) => t.promptSnapshot?.id === ref.id)) return turns
  const last = turns[turns.length - 1]
  if (last?.role === 'assistant' && !last.promptSnapshot && !last.content) {
    return [...turns.slice(0, -1), { ...last, promptSnapshot: ref }]
  }
  return [...turns, { role: 'assistant', content: '', promptSnapshot: ref }]
}

/**
 * Settle every tool row still `running` as an interrupted error: the run that
 * would have finished the call is gone. Returns the same array when nothing
 * was running, so callers can keep object identity.
 */
export function interruptRunningTools(turns: CoworkTurn[]): CoworkTurn[] {
  let changed = false
  const next = turns.map((tn) => {
    if (tn.role !== 'tool' || tn.status !== 'running') return tn
    changed = true
    return {
      ...tn,
      status: 'done' as const,
      isError: true,
      result: tn.result || '(interrupted)',
      toolState: 'stale' as const,
      endedAt: Date.now(),
    }
  })
  return changed ? next : turns
}

// Apply one wrapped inner subagent event to that subagent's own turn lane
// (token append / tool_call push / tool_result merge). Pure.
/** Exported so the event-to-turn mapping is testable on its own. */
export function applyInnerToTurns(turns: CoworkTurn[], inner: StreamEvent): CoworkTurn[] {
  switch (inner.type) {
    case 'token':
      return appendAssistantToken(turns, inner.text)
    case 'tool_call_started': {
      if (turns.some((tn) => tn.role === 'tool' && tn.callId === inner.id)) return turns
      return [
        ...turns,
        {
          role: 'tool',
          content: '',
          callId: inner.id,
          name: inner.name,
          args: null,
          argsLive: '',
          status: 'running',
          // Named before its arguments have finished streaming: the item
          // exists from the moment the call was requested.
          toolState: 'requested',
          startedAt: Date.now(),
        },
      ]
    }
    case 'tool_call_args_delta': {
      const idx = turns.findIndex((tn) => tn.role === 'tool' && tn.callId === inner.id)
      if (idx === -1) return turns
      const prev = turns[idx].argsLive ?? ''
      return [...turns.slice(0, idx), { ...turns[idx], argsLive: prev + inner.delta }, ...turns.slice(idx + 1)]
    }
    case 'prompt_snapshot': {
      // Arrives immediately before the model streams its reply, so it opens the
      // assistant turn that reply will be appended to. That is what ties a
      // snapshot to the invocation it belongs to.
      const last = turns[turns.length - 1]
      if (last?.role === 'assistant' && !last.promptSnapshot && !last.content) {
        return [
          ...turns.slice(0, -1),
          {
            ...last,
            promptSnapshot: {
              id: inner.id,
              hash: inner.hash,
              redactions: inner.redactions,
            },
          },
        ]
      }
      return [
        ...turns,
        {
          role: 'assistant',
          content: '',
          promptSnapshot: {
            id: inner.id,
            hash: inner.hash,
            redactions: inner.redactions,
          },
        },
      ]
    }
    case 'tool_call': {
      // The call may already be here from `tool_call_started`; that turn is
      // advanced rather than duplicated.
      const idx = turns.findIndex(
        (tn) => tn.role === 'tool' && tn.callId === inner.id
      )
      if (idx !== -1) {
        return [
          ...turns.slice(0, idx),
          {
            ...turns[idx],
            args: inner.args,
            argsLive: undefined,
            toolState: 'running',
          },
          ...turns.slice(idx + 1),
        ]
      }
      return [...turns, makeToolCallTurn(inner)]
    }
    case 'tool_result':
      return mergeToolResult(turns, inner.id, {
        result: inner.content,
        isError: inner.is_error,
        diff: inner.diff,
        status: 'done',
        // The same item, in a terminal state. Nothing is removed and no
        // separate result item is appended.
        toolState: toolOutcome(inner.is_error, inner.content),
        endedAt: Date.now(),
      })
    default:
      return turns // step / anything else: no visible turn
  }
}

export function omitKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}
