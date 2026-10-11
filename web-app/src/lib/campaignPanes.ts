/**
 * Pane accounting for campaign runs (docs/CAMPAIGNS.md).
 *
 * A task run only exists while its session is on screen, so panes bound
 * parallelism. A pane is free when it is empty, when the split has room for
 * another, or when it only shows a campaign task that has nothing running or
 * waiting to run (a settled task, or one of another campaign that finished):
 * that pane is recycled, not counted against new work. A pane showing anything
 * else (the user's own sessions and chats), or a task with a live run, a
 * pending seed, a live-status record or a start in the last grace period, is
 * occupied.
 */

export type PaneLike = { id: string; kind: string; refId?: string }

export type PaneAccountingInput = {
  panes: readonly PaneLike[]
  maxPanes: number
  /** Session ids with a run in progress. */
  liveSessions: ReadonlySet<string>
  /** Sessions that are a campaign task (a pointer with role task). */
  isTaskSession: (sessionId: string) => boolean
  /** Sessions that still have input waiting to be sent. */
  hasQueued: (sessionId: string) => boolean
  /** Sessions the runner knows are mid-start or hold a live-status task. */
  busy?: ReadonlySet<string>
}

export type PaneAccounting = {
  /** Panes new work can still use: room to add, empty ones and recyclable ones. */
  free: number
  /** Ids of panes that hold only an idle campaign task, oldest first. */
  recyclable: string[]
}

export function accountPanes(input: PaneAccountingInput): PaneAccounting {
  const { panes, maxPanes, liveSessions, isTaskSession, hasQueued, busy } = input
  const empty = panes.filter((p) => !p.refId).length
  const recyclable = panes
    .filter(
      (p) =>
        p.kind === 'cowork' &&
        !!p.refId &&
        isTaskSession(p.refId) &&
        !liveSessions.has(p.refId) &&
        !hasQueued(p.refId) &&
        !busy?.has(p.refId)
    )
    .map((p) => p.id)
  const room = Math.max(0, maxPanes - 1 - panes.length)
  return { free: room + empty + recyclable.length, recyclable }
}
