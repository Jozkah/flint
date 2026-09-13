/**
 * Chat's side of the canonical execution record (AH-004).
 *
 * Cowork has a run id and an invocation id for every model request, and writes
 * `run.started`, `usage.reported`, `message.completed` and `run.ended` around
 * its tool calls. Chat had neither: its tool events were written with an empty
 * run and no invocation, so a timeline or an audit export could see that a
 * chat called a tool but not which request asked for it, what that request
 * cost, or how the turn ended.
 *
 * The identity lives here rather than in the transport because two places need
 * it and neither owns the other: the transport knows when a request starts and
 * what it cost, and the thread route runs the tools the reply asked for. One
 * map, keyed by thread, written by the transport and read by the route.
 *
 * Nothing here throws: a run that cannot be recorded still has to run.
 */
import { recordEvents } from '@/lib/eventLog'

export type ChatRunIdentity = {
  /** The turn: one user message and everything the model did answering it. */
  run: string
  /** The model request inside that turn. New for every step. */
  invocation: string
  /** Steps taken so far, which is what numbers the invocations. */
  steps: number
  /**
   * The last request asked for tools, so the turn is not over: the tools run
   * here and their results go back in another request. Chat's tool calls
   * happen between requests, so without this a turn with one tool call would
   * be recorded as two runs with the tools outside both.
   */
  awaitingTools: boolean
  /** The snapshot id of the last request this turn sent, when one was taken. */
  snapshot?: string
}

const runs = new Map<string, ChatRunIdentity>()

let counter = 0

const unique = (prefix: string) => {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`
}

/** The identity of the turn running in `threadId`, if one is. */
export function chatRunOf(threadId: string | undefined): ChatRunIdentity | undefined {
  return threadId ? runs.get(threadId) : undefined
}

/**
 * Start a turn. Records `run.started`, so a turn that is cancelled before its
 * first token is still in the record rather than missing from it.
 */
export function beginChatRun(
  threadId: string,
  details: { model?: string } = {}
): ChatRunIdentity {
  const run = unique(`chat:${threadId}`)
  const identity: ChatRunIdentity = { run, invocation: '', steps: 0, awaitingTools: false }
  runs.set(threadId, identity)
  void recordEvents([
    {
      id: `run:${run}:started`,
      session: threadId,
      run,
      kind: 'run.started',
      payload: { model: details.model ?? '', source: 'chat' },
    },
  ])
  return identity
}

/**
 * The request that starts, or continues, a turn.
 *
 * A reply that asked for tools is not the end of the turn: the tools run
 * between requests, and the next request is the same turn continuing. Any
 * other open run is closed first rather than being extended silently.
 */
export function continueOrBeginChatRun(
  threadId: string,
  details: { model?: string } = {}
): ChatRunIdentity {
  const open = runs.get(threadId)
  if (open?.awaitingTools) {
    open.awaitingTools = false
    return open
  }
  if (open) endChatRun(threadId, 'done')
  return beginChatRun(threadId, details)
}

/** Say whether the reply just finished asked for tools. */
export function markChatAwaitingTools(threadId: string, awaiting: boolean): void {
  const identity = runs.get(threadId)
  if (identity) identity.awaitingTools = awaiting
}

/** Whether the turn is waiting for tools to run before its next request. */
export function chatAwaitsTools(threadId: string): boolean {
  return runs.get(threadId)?.awaitingTools === true
}

/**
 * The next model request of the turn. Each step gets its own invocation id, so
 * a provider that numbers its tool calls per request cannot make two calls look
 * like one.
 */
export function nextChatInvocation(threadId: string): string {
  const identity = runs.get(threadId)
  if (!identity) return ''
  identity.steps += 1
  identity.invocation = `${identity.run}#${identity.steps}`
  return identity.invocation
}

/**
 * The snapshot a Chat request was taken of, as the transport reports it.
 *
 * Two things need it, and neither could prove anything without it: the record
 * of *which payload* this request sent (AH-032, so a Chat turn can be replayed
 * from the record rather than reconstructed), and the note that a memory was
 * used in it (AH-083, so "used in this turn" names the exact request).
 */
export function recordChatDispatch(
  threadId: string,
  snapshot: { id: string; hash: string; redactions?: number; invocation?: string }
): void {
  const identity = runs.get(threadId)
  if (!identity || !snapshot.id) return
  identity.snapshot = snapshot.id
  void recordEvents([
    {
      id: `dispatch:${snapshot.invocation || snapshot.id}`,
      session: threadId,
      run: identity.run,
      invocation: snapshot.invocation ?? identity.invocation,
      kind: 'message.completed',
      payload: {
        phase: 'dispatched',
        snapshotId: snapshot.id,
        hash: snapshot.hash,
        ...(snapshot.redactions === undefined ? {} : { redactions: snapshot.redactions }),
      },
    },
  ])
}

/** The last request this turn sent, when one has been taken. */
export function chatSnapshotId(threadId: string | undefined): string | undefined {
  return threadId ? runs.get(threadId)?.snapshot : undefined
}

/** What one request cost, against the request it belongs to. */
export function recordChatUsage(
  threadId: string,
  invocation: string,
  payload: Record<string, unknown>
): void {
  const identity = runs.get(threadId)
  if (!identity || !invocation) return
  void recordEvents([
    {
      id: `usage:${invocation}`,
      session: threadId,
      run: identity.run,
      invocation,
      kind: 'usage.reported',
      payload,
    },
  ])
}

/** What the reply was made of: sizes and counts, never the words. */
export function recordChatMessage(
  threadId: string,
  invocation: string,
  payload: Record<string, unknown>
): void {
  const identity = runs.get(threadId)
  if (!identity) return
  void recordEvents([
    {
      id: `message:${invocation || identity.run}`,
      session: threadId,
      run: identity.run,
      invocation,
      kind: 'message.completed',
      payload,
    },
  ])
}

/**
 * End the turn, saying how it ended: `done`, `cancelled` or `error`. Idempotent
 * -- a stream that both errors and is aborted ends once, as one run did.
 */
export function endChatRun(
  threadId: string,
  stoppedBy: 'done' | 'cancelled' | 'error',
  detail?: string
): void {
  const identity = runs.get(threadId)
  if (!identity) return
  runs.delete(threadId)
  void recordEvents([
    {
      id: `run:${identity.run}:ended`,
      session: threadId,
      run: identity.run,
      kind: 'run.ended',
      payload: {
        stoppedBy,
        source: 'chat',
        steps: identity.steps,
        ...(detail ? { detail } : {}),
      },
    },
  ])
}

export const __testing = {
  reset: () => {
    runs.clear()
    counter = 0
  },
  runs,
}
