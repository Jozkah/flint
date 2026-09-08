/**
 * Stopping a run that has stopped getting anywhere. AH-029 / AH-030.
 *
 * A model that cannot make progress does not stop; it repeats. The shapes it
 * repeats in are recognisable -- the same call again, the same call spelled
 * differently, the same failure, an edit reverted and re-made, a subagent
 * delegating to a subagent -- and each of them will otherwise run to the step
 * budget, spending the user's time and tokens on nothing.
 *
 * The guard is not something the model can talk its way out of. It is counted
 * here, from what actually happened, and the run is stopped or paused whatever
 * the model says about it: a model in a loop is precisely the one most likely
 * to insist it is about to finish.
 */

export type LoopReason =
  /** The same call, byte for byte, more than the limit allows. */
  | 'repeated-call'
  /** The same call in a different spelling. */
  | 'equivalent-call'
  /** The same call failing the same way. */
  | 'repeated-failure'
  /** Edits that undo each other, leaving the file where it started. */
  | 'no-progress'
  /** A subagent delegating deeper than the run allows. */
  | 'recursive-delegation'

export type LoopVerdict =
  | { tripped: false }
  | { tripped: true; reason: LoopReason; detail: string }

/**
 * How many times a shape may repeat before it counts as a loop.
 *
 * Five for an identical call, not three: re-reading a file after editing it,
 * or running the same test command twice while fixing it, is ordinary work,
 * and a guard that stops ordinary work gets turned off. A *failure* repeating
 * is stronger evidence and is allowed fewer.
 */
export const REPEAT_LIMIT = 5
export const FAILURE_LIMIT = 3
export const NO_PROGRESS_LIMIT = 2
export const DELEGATION_DEPTH_LIMIT = 3

export type ObservedCall = {
  tool: string
  input: unknown
  /** Set once the call has settled. */
  failed?: boolean
  /** The error text, so two different failures do not count as a repeat. */
  error?: string
  /** The path a write or edit touched, when it touched one. */
  path?: string
  /** The content it left behind, hashed by the caller or passed whole. */
  after?: string
  /** How deep in the subagent tree this call was made. */
  depth?: number
}

/**
 * A call's identity for comparison purposes.
 *
 * Key order and whitespace are not meaning: `{"path":"a","text":"x"}` and
 * `{ "text":"x", "path":"a" }` are the same call, and a model that alternates
 * between the two spellings is looping just as surely as one that does not.
 */
export function canonicalKey(call: {
  tool: string
  input: unknown
}): string {
  return `${call.tool}::${canonicalJson(call.input)}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? value.trim() : JSON.stringify(value) ?? ''
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys
    .map((key) => `${key}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

/**
 * Whether the run has stopped making progress.
 *
 * Takes the whole history rather than being fed one call at a time, so the
 * guard has no state of its own to get out of step with the run -- and so it
 * gives the same verdict when it is re-checked after a restart.
 */
export function detectLoop(calls: ObservedCall[]): LoopVerdict {
  if (calls.length === 0) return { tripped: false }

  // Recursive delegation, checked first: it is the shape that multiplies
  // rather than merely repeats.
  const deepest = calls.reduce((max, call) => Math.max(max, call.depth ?? 0), 0)
  if (deepest >= DELEGATION_DEPTH_LIMIT) {
    return {
      tripped: true,
      reason: 'recursive-delegation',
      detail: `delegation reached depth ${deepest}`,
    }
  }

  const exact = new Map<string, number>()
  const failures = new Map<string, number>()
  for (const call of calls) {
    const key = canonicalKey(call)
    const seen = (exact.get(key) ?? 0) + 1
    exact.set(key, seen)
    if (seen >= REPEAT_LIMIT) {
      // Identical spelling and canonically equivalent spelling are counted by
      // the same key on purpose: to the workspace they are the same call.
      const spellings = new Set(
        calls
          .filter((one) => canonicalKey(one) === key)
          .map((one) => JSON.stringify(one.input))
      )
      return {
        tripped: true,
        reason: spellings.size > 1 ? 'equivalent-call' : 'repeated-call',
        detail: `${call.tool} called ${seen} times with the same arguments`,
      }
    }

    if (call.failed) {
      // Keyed on the tool and the error, not the arguments: a model that
      // tries `foo 1`, `foo 2` and `foo 3` and is told "command not found"
      // every time is in the same loop as one that repeats a single call, and
      // changing a digit each round should not buy it another attempt.
      const failureKey = `${call.tool}::${call.error ?? ''}`
      const count = (failures.get(failureKey) ?? 0) + 1
      failures.set(failureKey, count)
      if (count >= FAILURE_LIMIT) {
        return {
          tripped: true,
          reason: 'repeated-failure',
          detail: `${call.tool} failed ${count} times the same way`,
        }
      }
    }
  }

  const churn = noProgressCycle(calls)
  if (churn) return churn

  return { tripped: false }
}

/**
 * Edits that put a file back where it already was.
 *
 * Two writes to one path whose results alternate between the same two states
 * is a model arguing with itself. Counting writes alone would flag a file
 * being built up in steps, which is ordinary work.
 */
function noProgressCycle(calls: ObservedCall[]): LoopVerdict | null {
  const byPath = new Map<string, string[]>()
  for (const call of calls) {
    if (!call.path || call.after == null) continue
    const states = byPath.get(call.path) ?? []
    states.push(call.after)
    byPath.set(call.path, states)
  }

  for (const [path, states] of byPath) {
    if (states.length < NO_PROGRESS_LIMIT * 2) continue
    let reverts = 0
    for (let i = 2; i < states.length; i++) {
      // The file returned to a state it was already in.
      if (states[i] === states[i - 2]) reverts += 1
    }
    if (reverts >= NO_PROGRESS_LIMIT) {
      return {
        tripped: true,
        reason: 'no-progress',
        detail: `${path} was returned to an earlier state ${reverts} times`,
      }
    }
  }
  return null
}

/** What to tell the model when the guard stops a run. */
export function loopStopMessage(verdict: LoopVerdict & { tripped: true }): string {
  return (
    `Stopped: ${verdict.detail}. This is not making progress. ` +
    'Say what you were trying to do and what is in the way, and wait for ' +
    'instructions rather than trying again.'
  )
}
