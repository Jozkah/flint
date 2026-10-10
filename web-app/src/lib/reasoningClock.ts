/**
 * How long a reply spent thinking, measured from its stream parts.
 *
 * The "Thought for N s" header used to rely on a timer inside the component,
 * which a reload or a thread switch loses. The transport feeds the parts here
 * and stores the total in the message metadata (`reasoningMs`), so it survives.
 */
export type ReasoningClock = {
  /** Feed every stream part's `type` as it arrives. */
  observe: (partType: string, now?: number) => void
  /** Milliseconds spent in reasoning so far (an open block counts to `now`). */
  totalMs: (now?: number) => number
}

const OPENS = new Set(['reasoning-start', 'reasoning-delta'])
// Anything that is not reasoning ends the open block: the model moved on.
const CLOSES = new Set([
  'reasoning-end',
  'text-start',
  'text-delta',
  'tool-input-start',
  'tool-call',
  'finish-step',
  'finish',
  'abort',
])

export function createReasoningClock(): ReasoningClock {
  let openedAt: number | null = null
  let total = 0
  return {
    observe(partType, now = Date.now()) {
      if (OPENS.has(partType)) {
        if (openedAt === null) openedAt = now
      } else if (CLOSES.has(partType) && openedAt !== null) {
        total += Math.max(0, now - openedAt)
        openedAt = null
      }
    },
    totalMs(now = Date.now()) {
      return total + (openedAt === null ? 0 : Math.max(0, now - openedAt))
    },
  }
}

/** Whole seconds, at least 1, from a message's stored `reasoningMs`; else undefined. */
export function thoughtSecondsFromMetadata(
  metadata: Record<string, unknown> | undefined
): number | undefined {
  const ms = metadata?.reasoningMs
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined
  return Math.max(1, Math.ceil(ms / 1000))
}
