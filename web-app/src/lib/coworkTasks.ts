// Reading facts about background work out of the shapes the run produces.
//
// This used to derive the whole activity list — subagents from two lanes,
// commands recovered from the transcript, merged with the backend's job list.
// That derivation is gone: `coworkActivity` records the same work as it
// happens, from the dispatch that started it, which is both more accurate and
// the only copy. What is left are the small readers recording still needs,
// plus the shape of a live backend job.

import type { CoworkTurn } from '@/types/coworkSession'

/**
 * The job id the `bash` tool reports when a command outruns its timeout.
 *
 * Rust prints a fixed sentence — see `handlers.rs`'s background branch — and
 * the whole sentence is matched, not just the `job_id=` fragment. The text
 * handed here is the tool's entire output, which includes the command's own
 * stdout: `grep -rn job_id src/` prints lines containing `job_id=` and would
 * otherwise be read as having been backgrounded, stranding it as "running"
 * forever and pointing its Stop button at a job that does not exist.
 */
export function backgroundJobId(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const match = text.match(
    /is continuing in the background \(job_id=([A-Za-z0-9_-]+)\)/
  )
  return match ? match[1] : null
}

/** How many tool calls a transcript contains. */
export function countToolCalls(turns: CoworkTurn[] | undefined): number {
  return (turns ?? []).filter((turn) => turn.role === 'tool').length
}

/** The command line a `bash` call carries, when its arguments have parsed. */
export const commandOf = (args: unknown): string | undefined => {
  if (args && typeof args === 'object' && 'command' in args) {
    const value = (args as Record<string, unknown>).command
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

/** The `job_id` a `bash` call passed to collect a backgrounded command. */
export const collectedJobId = (args: unknown): string | undefined => {
  if (args && typeof args === 'object' && 'job_id' in args) {
    const value = (args as Record<string, unknown>).job_id
    return typeof value === 'string' && value ? value : undefined
  }
  return undefined
}

/** A live background job, as the backend reports it. */
export type LiveJob = {
  jobId: string
  command: string
  elapsedMs: number
  finished: boolean
  callId?: string | null
}
