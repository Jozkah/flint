/**
 * Restarting or replacing one failed member of a running team (AH-111).
 *
 * A team used to retry a failed task only automatically (`retries`, capped at
 * `MAX_TASK_RETRIES`). Once those were spent the task was failed for good,
 * everything downstream was blocked, and the only way to try again was to run
 * the whole team -- the whole run -- again.
 *
 * Now a failed task can be restarted as it was, or replaced -- given to a
 * different subagent, or with a corrected brief -- while its team is still
 * running. Its dependents that were blocked only because of it become pending
 * again, so they run once it completes. A team that would end with failures
 * holds for a bounded window (`DECISION_WINDOW_MS`) instead of ending, so a
 * person can still decide; it ends when they finish it, when they stop the
 * run, or when the window passes with nobody deciding -- and says which.
 * Nothing restarts on its own.
 */
import type { TaskStatus, TeamState, TeamTask } from '@/lib/coworkTeam'

/** A change to a failed task. */
export type Replacement = {
  subagentName?: string
  description?: string
}

export type ControlRefusal =
  | { kind: 'not-found'; message: string }
  | { kind: 'not-failed'; message: string }
  | { kind: 'team-finished'; message: string }
  | { kind: 'invalid-replacement'; message: string }

export type ControlResult = { ok: true } | { ok: false; refusal: ControlRefusal }

/** What a person asked the running team to do. */
export type ControlRequest =
  | { kind: 'restart'; taskId: string }
  | { kind: 'replace'; taskId: string; with: Replacement }
  | { kind: 'finish' }

/**
 * Check a request against the team as it stands. Pure, so the rules are
 * tested without a running team.
 */
export function checkRequest(
  tasks: readonly TeamTask[],
  state: TeamState,
  request: ControlRequest,
  finished: boolean
): ControlResult {
  if (finished) {
    return refuse('team-finished', 'the team has already ended; run it again to retry this task')
  }
  if (request.kind === 'finish') return { ok: true }
  const task = tasks.find((t) => t.id === request.taskId)
  if (!task) return refuse('not-found', `no task "${request.taskId}" in this team`)
  const status: TaskStatus = state[task.id]?.status ?? 'pending'
  if (status !== 'failed') {
    return refuse(
      'not-failed',
      `task "${task.id}" is ${status}; only a failed task can be restarted or replaced`
    )
  }
  if (request.kind === 'replace') {
    const change = request.with
    const description = change.description?.trim()
    const agent = change.subagentName?.trim()
    if (change.description !== undefined && !description) {
      return refuse('invalid-replacement', 'a replacement brief cannot be empty')
    }
    if (change.subagentName !== undefined && !agent) {
      return refuse('invalid-replacement', 'a replacement subagent needs a name')
    }
    if (description === undefined && agent === undefined) {
      return refuse('invalid-replacement', 'a replacement changes the subagent, the brief, or both')
    }
    if (
      (description ?? task.description) === task.description &&
      (agent ?? task.subagentName) === task.subagentName
    ) {
      return refuse('invalid-replacement', 'the replacement is the same as the task; restart it instead')
    }
  }
  return { ok: true }
}

function refuse(kind: ControlRefusal['kind'], message: string): ControlResult {
  return { ok: false, refusal: { kind, message } }
}

/** The graph with one task changed as `with` says. */
export function applyReplacement(
  tasks: readonly TeamTask[],
  taskId: string,
  change: Replacement
): TeamTask[] {
  return tasks.map((task) =>
    task.id !== taskId
      ? task
      : {
          ...task,
          ...(change.description !== undefined ? { description: change.description.trim() } : {}),
          ...(change.subagentName !== undefined ? { subagentName: change.subagentName.trim() } : {}),
        }
  )
}

/**
 * The state with `taskId` pending again, and every task that was blocked only
 * because of it (directly or through another blocked task) pending again too.
 * A task still blocked by a different failure stays blocked.
 */
export function reopen(
  tasks: readonly TeamTask[],
  state: TeamState,
  taskId: string
): TeamState {
  const next: TeamState = { ...state, [taskId]: { status: 'pending' } }
  const stuckBy = (task: TeamTask, s: TeamState) =>
    task.dependsOn.some((dep) => {
      const status = s[dep]?.status
      return status === 'failed' || status === 'cancelled' || status === 'blocked'
    })
  // Unblock everything, then re-block what is still stuck, until stable: the
  // same fixed point `settle` reaches, computed from the reopened task.
  for (const task of tasks) {
    if (next[task.id]?.status === 'blocked') next[task.id] = { status: 'pending' }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const task of tasks) {
      if (next[task.id]?.status !== 'pending' || task.id === taskId) continue
      if (stuckBy(task, next)) {
        next[task.id] = { status: 'blocked' }
        changed = true
      }
    }
  }
  return next
}

/**
 * How long a team that would end with failures waits for a person to decide.
 *
 * Bounded, because the wait happens inside the agent's own tool call: an
 * unattended run -- nobody at the Tasks panel -- must not block forever on a
 * decision nobody is there to make. When it passes, the team ends as it would
 * have, and says that no decision came.
 */
export const DECISION_WINDOW_MS = 5 * 60 * 1000

/**
 * The hold Cowork itself uses: long enough for someone watching the Tasks
 * panel to press Restart, short enough that an unattended run reports its
 * failures within a minute instead of sitting silent for five.
 */
export const COWORK_DECISION_WINDOW_MS = 60 * 1000

/** Whether a team with this state should hold for a decision rather than end. */
export function awaitingDecision(state: TeamState): boolean {
  return Object.values(state).some((s) => s.status === 'failed')
}

/**
 * The handle the Tasks panel uses to reach a running team. `runTeam` drains
 * it; a request made after the team ended is refused by `checkRequest`.
 */
export class TeamControl {
  private queue: ControlRequest[] = []
  private waiters: Array<() => void> = []
  finished = false

  request(request: ControlRequest): void {
    this.queue.push(request)
    for (const wake of this.waiters.splice(0)) wake()
  }

  /** Every request made since the last take, in order. */
  take(): ControlRequest[] {
    return this.queue.splice(0)
  }

  /**
   * Resolves when a request arrives, or at once if one is waiting; also when
   * the run is stopped, and after `timeoutMs` when one is given. Resolves
   * `true` only when a request is waiting.
   */
  next(signal?: AbortSignal, timeoutMs?: number): Promise<boolean> {
    if (this.queue.length > 0) return Promise.resolve(true)
    if (signal?.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        signal?.removeEventListener('abort', done)
        if (timer !== undefined) clearTimeout(timer)
        resolve(this.queue.length > 0)
      }
      this.waiters.push(done)
      signal?.addEventListener('abort', done, { once: true })
      if (timeoutMs !== undefined) timer = setTimeout(done, Math.max(0, timeoutMs))
    })
  }
}
