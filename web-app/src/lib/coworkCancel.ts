/**
 * Cancelling one unit of background work.
 *
 * Two kinds of work, two mechanisms, one honest answer:
 *
 * - an **agent** task is stopped by aborting its own controller, which the run
 *   registers per dispatch (`registerSubagent`). Aborting the run would stop
 *   everything; this stops one child.
 * - a **shell** task is stopped by killing its process group through
 *   `bash_job_kill`, which needs the backend job id. A command that has not
 *   been backgrounded has no job id, and the `execute_tool` invoke carrying it
 *   takes no cancellation token — so there is nothing to signal, and this says
 *   so rather than pretending.
 *
 * The outcome is always reported, never assumed: a surface that greys out a
 * row it did not actually stop is worse than one that says it could not.
 */

import { bashJobKill } from '@janhq/tauri-plugin-agent-tools-api'
import { abortSubagent } from '@/lib/coworkRunner'
import {
  cancellableTasks,
  isFinished,
  type ActivityTask,
  type WorkflowView,
} from '@/lib/coworkActivity'

export type CancelOutcome =
  /** The work was signalled to stop. */
  | 'cancelled'
  /** It had already finished; nothing was signalled. */
  | 'alreadyFinished'
  /** Nothing left to signal: the run is gone, or the job is unknown. */
  | 'notRunning'
  /** This kind of work cannot be reached — a foreground command in flight. */
  | 'unreachable'
  /** The attempt itself failed. */
  | 'failed'

export type CancelResult = {
  taskId: string
  outcome: CancelOutcome
  /** Present when the attempt failed, for the message shown to the user. */
  error?: string
}

/** Recorded as a cancelled task's reason, so the record says who stopped it. */
export const CANCELLED_BY_USER = 'cancelled:user'

type Deps = {
  abortAgent: typeof abortSubagent
  killJob: typeof bashJobKill
}

const defaultDeps: Deps = { abortAgent: abortSubagent, killJob: bashJobKill }

export async function cancelTask(
  sessionId: string,
  task: ActivityTask,
  deps: Deps = defaultDeps
): Promise<CancelResult> {
  if (isFinished(task.status)) {
    return { taskId: task.id, outcome: 'alreadyFinished' }
  }

  if (task.kind === 'agent') {
    const stopped = deps.abortAgent(sessionId, task.id, CANCELLED_BY_USER)
    return { taskId: task.id, outcome: stopped ? 'cancelled' : 'notRunning' }
  }

  // A shell command is only reachable once it has been backgrounded: that is
  // when the backend records a job, and a job is what holds the pid.
  if (!task.jobId) return { taskId: task.id, outcome: 'unreachable' }

  try {
    // Scoped to the session the job ran under: the backend refuses (as
    // "unknown") a job another conversation started.
    const killed = await deps.killJob(task.jobId, sessionId)
    switch (killed.outcome) {
      case 'killed':
        return { taskId: task.id, outcome: 'cancelled' }
      case 'alreadyFinished':
        return { taskId: task.id, outcome: 'alreadyFinished' }
      // The OS refused. The command is still running and the backend kept its
      // pid, so this can be asked again — which is why it is a failure rather
      // than "nothing to stop".
      case 'failed':
        return {
          taskId: task.id,
          outcome: 'failed',
          error: killed.error ?? undefined,
        }
      // `noPid` means the backend holds the job but never captured a process to
      // signal; `unknown` means it no longer holds it at all. Neither stopped
      // anything, and neither is a failure of this call.
      case 'noPid':
      case 'unknown':
        return { taskId: task.id, outcome: 'notRunning' }
    }
  } catch (e) {
    return {
      taskId: task.id,
      outcome: 'failed',
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * How the activity record should change once a cancel has been attempted.
 *
 * Only an outcome that actually stopped something marks the task cancelled.
 * `notRunning` and `unreachable` leave the row alone: the work is still going,
 * or is about to settle on its own, and marking it cancelled would be a claim
 * the app cannot back up.
 *
 * A failed attempt is written onto the row as well as told: the work is still
 * running, and a toast that disappears would leave nothing saying the stop
 * did not happen.
 */
export function patchForOutcome(
  result: CancelResult,
  now: number
): Partial<ActivityTask> | null {
  if (result.outcome === 'failed') {
    return { cancelError: result.error || 'the stop request failed' }
  }
  if (result.outcome !== 'cancelled') return null
  return {
    status: 'cancelled',
    endedAt: now,
    detail: CANCELLED_BY_USER,
    cancelError: undefined,
  }
}

/**
 * What to tell the user when a cancel stopped nothing.
 *
 * Only called for the outcomes that changed nothing, so each one names its own
 * reason instead of a single vague "could not cancel".
 */
export function cancelMessage(
  result: CancelResult,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  switch (result.outcome) {
    case 'alreadyFinished':
      return t('common:tasks.cancelAlreadyFinished')
    case 'unreachable':
      return t('common:tasks.cancelUnreachable')
    case 'failed':
      return t('common:tasks.cancelFailed', { error: result.error ?? '' })
    default:
      return t('common:tasks.cancelNotRunning')
  }
}

/** What stopping a whole workflow achieved. */
export type WorkflowCancelResult = {
  workflowId: string
  /** One entry per child the attempt reached. */
  results: CancelResult[]
  /** Children actually stopped. */
  cancelled: number
  /** Children the attempt could not stop, for whatever reason. */
  failed: number
}

/**
 * Stop every child of one workflow that can still be reached.
 *
 * Scoped to that workflow's own tasks, so a second run in the same session —
 * and every other session — is untouched. Children already finished are left
 * exactly as they are: their transcript, output and usage are the record of
 * what happened, and stopping something that is over would rewrite it.
 *
 * Partial failure is reported rather than smoothed over: with three children
 * of which one refuses to die, the caller needs to be able to say so.
 */
export async function cancelWorkflow(
  sessionId: string,
  view: WorkflowView,
  opts: {
    agentReachable?: (task: ActivityTask) => boolean
    deps?: Deps
  } = {}
): Promise<WorkflowCancelResult> {
  const targets = cancellableTasks(view.tasks, {
    agentReachable: opts.agentReachable,
  })
  const results = await Promise.all(
    targets.map((task) => cancelTask(sessionId, task, opts.deps ?? defaultDeps))
  )
  return {
    workflowId: view.workflow.id,
    results,
    cancelled: results.filter((r) => r.outcome === 'cancelled').length,
    failed: results.filter((r) => r.outcome !== 'cancelled').length,
  }
}
