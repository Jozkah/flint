/**
 * What the header's live-work pills list: the approval prompts waiting on the
 * user, and the Cowork runs in progress. Pure, so the order and the rows each
 * pill opens can be tested without rendering the shell.
 */
import type { CoworkTurn } from '@/types/coworkSession'

export type WaitingApprovalRow = {
  requestId: string
  threadId: string
  /** The conversation's title, or undefined when it has none yet. */
  title?: string
  tool: string
  /** How long it has waited, or undefined when the request carries no time. */
  waitingMs?: number
}

/**
 * Every waiting prompt, oldest first. A prompt with no request time sorts
 * last: it cannot be shown to have waited longest.
 */
export function waitingApprovalRows(
  entries: readonly {
    requestId: string
    threadId: string
    toolName: string
    requestedAt?: number
  }[],
  titleOf: (threadId: string) => string | undefined,
  now: number
): WaitingApprovalRow[] {
  return entries
    .map((e, index) => ({ e, index }))
    .sort((a, b) => {
      const at = a.e.requestedAt ?? Infinity
      const bt = b.e.requestedAt ?? Infinity
      return at === bt ? a.index - b.index : at - bt
    })
    .map(({ e }) => ({
      requestId: e.requestId,
      threadId: e.threadId,
      title: titleOf(e.threadId),
      tool: e.toolName,
      waitingMs:
        e.requestedAt === undefined ? undefined : Math.max(0, now - e.requestedAt),
    }))
}

export type RunningRow = {
  sessionId: string
  title?: string
  elapsedMs: number
  /** The tool the run is on now, or the last one it called. */
  step?: string
}

/** The step a run is on: its running tool call, else its latest one. */
export function currentRunStep(turns: readonly CoworkTurn[] | undefined): string | undefined {
  if (!turns) return undefined
  let last: string | undefined
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn.role !== 'tool') continue
    if (turn.status === 'running') return turn.name
    last ??= turn.name
  }
  return last
}

/** Every Cowork run in progress, longest-running first. */
export function runningRows(
  runs: Record<string, { startedAt: number }>,
  titleOf: (sessionId: string) => string | undefined,
  liveTurns: Record<string, CoworkTurn[] | undefined>,
  now: number
): RunningRow[] {
  return Object.entries(runs)
    .sort(([, a], [, b]) => a.startedAt - b.startedAt)
    .map(([sessionId, run]) => ({
      sessionId,
      title: titleOf(sessionId),
      elapsedMs: Math.max(0, now - run.startedAt),
      step: currentRunStep(liveTurns[sessionId]),
    }))
}

/** "45 s", "3 min", "2 h 5 min": short enough for a pill's card. */
export function formatWait(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}
