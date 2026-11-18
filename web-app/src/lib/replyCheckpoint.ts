import type { ThreadMessage } from '@janhq/core'

/** Marks a reply saved while it was still streaming (the stream had not ended). */
export const CHECKPOINT_MARK = 'checkpoint'
/** What a checkpoint left behind by a dead app becomes on the next load. */
export const CRASH_MARK = 'crash'

/**
 * Replies a dead app left as checkpoints (their stream never ended) become
 * stopped, interrupted replies, so the thread offers Continue instead of
 * showing half an answer as if it were whole. Returns the changed messages.
 * Call it only for a thread nothing is streaming into.
 */
export function settleCrashedCheckpoints(
  messages: ThreadMessage[]
): ThreadMessage[] {
  const out: ThreadMessage[] = []
  for (const m of messages) {
    const meta = m.metadata as Record<string, unknown> | undefined
    if (m.role !== 'assistant' || meta?.interrupted !== CHECKPOINT_MARK) continue
    out.push({
      ...m,
      metadata: { ...meta, stopped: true, interrupted: CRASH_MARK },
    })
  }
  return out
}
