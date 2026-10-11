/**
 * What the status board does on the user's behalf (docs/CAMPAIGNS.md).
 *
 * Each action reuses a path that already exists: `abortRun` and the settle in
 * the runner for stop, `campaign_merge skip` (a transition to cancelled) for
 * skip, a transition back to queued for retry, the `campaign_steer` mail path
 * for a note, and the gate-then-proposal flow of `campaign_merge finalize`.
 * The backend validates every move, so a stale button fails with its reason.
 */
import type { CampaignApi } from '@/lib/campaignApi'
import type { Campaign } from '@/lib/campaignModel'
import { taskActionsOf } from '@/lib/campaignView'
import { messageIdOf } from '@/lib/campaignNotes'
import { retryHintDetail } from '@/lib/campaignSeed'

export type BoardDeps = {
  api: Pick<
    CampaignApi,
    'get' | 'transition' | 'context' | 'gatePlan' | 'finalize' | 'refresh'
  >
  runner: {
    kick: (id: string) => Promise<unknown>
    cancel: (id: string, detail?: string) => Promise<Campaign>
    integrate: (id: string) => Promise<{ campaign: Campaign }>
    /** Ask the verifier again about a finished task. */
    verifyTask: (
      id: string,
      taskId: string
    ) => Promise<{ skipped: string } | { next: string; verdict: string }>
  }
  /** campaign_steer's send path: from the coordinator to the task session. */
  sendMessage: (
    from: string,
    to: string,
    text: string
  ) => Promise<{ ok: true; output: string } | { ok: false; error: string }>
  abortRun: (sessionId: string) => void
  liveSessions: () => Set<string>
  /** A note left the board: remember it so the card can show it arriving. */
  noteSent?: (
    campaignId: string,
    taskId: string,
    sessionId: string,
    messageId: string
  ) => void
}

export type ActionResult = { ok: true; note?: string } | { ok: false; error: string }

const fail = (error: string): ActionResult => ({ ok: false, error })

export function createBoardActions(deps: BoardDeps) {
  const taskOf = async (id: string, taskId: string) => {
    const c = await deps.api.get(id)
    return { c, task: c.tasks.find((t) => t.id === taskId) }
  }

  const sendNote = async (
    id: string,
    taskId: string,
    text: string
  ): Promise<ActionResult> => {
    const note = text.trim()
    if (!note) return fail('empty note')
    const { c, task } = await taskOf(id, taskId)
    if (!task?.sessionId) return fail(`task ${taskId} has no session yet`)
    if (!taskActionsOf(task).note) {
      return fail(`task ${taskId} is ${task.status}, so there is nothing to steer`)
    }
    const sent = await deps.sendMessage(c.coordinatorSession, task.sessionId, note)
    if (!sent.ok) return fail(sent.error)
    const messageId = messageIdOf(sent.output)
    if (messageId) deps.noteSent?.(c.id, taskId, task.sessionId, messageId)
    return { ok: true, note: sent.output }
  }

  /**
   * A live run is aborted and the runner settles it as cancelled when it ends;
   * a task that is not running is cancelled by the transition directly.
   */
  const stopTask = async (id: string, taskId: string): Promise<ActionResult> => {
    const { task } = await taskOf(id, taskId)
    if (!task) return fail(`no task ${taskId}`)
    if (!taskActionsOf(task).stop) return fail(`task ${taskId} is ${task.status}`)
    if (task.sessionId && deps.liveSessions().has(task.sessionId)) {
      deps.abortRun(task.sessionId)
      return { ok: true }
    }
    await deps.api.transition(id, { task: { id: taskId, to: 'cancelled' } })
    return { ok: true }
  }

  const skipTask = async (id: string, taskId: string): Promise<ActionResult> => {
    const { task } = await taskOf(id, taskId)
    if (!task) return fail(`no task ${taskId}`)
    if (!taskActionsOf(task).skip) {
      return fail(`task ${taskId} is ${task.status} and cannot be skipped`)
    }
    await deps.api.transition(id, { task: { id: taskId, to: 'cancelled' } })
    // Skipping may have been the last open task.
    await deps.runner.kick(id)
    return { ok: true }
  }

  const retryTask = async (
    id: string,
    taskId: string,
    hint?: string
  ): Promise<ActionResult> => {
    const { task } = await taskOf(id, taskId)
    if (!task) return fail(`no task ${taskId}`)
    if (!taskActionsOf(task).retry) {
      return fail(`task ${taskId} is ${task.status} and cannot be retried`)
    }
    // Without a hint the old failure text is left alone, as before.
    const detail = retryHintDetail(hint)
    await deps.api.transition(id, {
      task: {
        id: taskId,
        to: 'queued',
        ...(detail ? { patch: { detail } } : {}),
      },
    })
    await deps.runner.kick(id)
    return { ok: true }
  }

  /**
   * Ask the verifier again, for a finished task whose check was blocked (the
   * model could not be reached, or the evidence was too thin). Nothing is
   * decided for the person: the verdict is whatever the verifier now says.
   */
  const verifyAgain = async (id: string, taskId: string): Promise<ActionResult> => {
    const { task } = await taskOf(id, taskId)
    if (!task) return fail(`no task ${taskId}`)
    if (!taskActionsOf(task).verify) {
      return fail(`task ${taskId} is ${task.status}, so it is not waiting to be checked`)
    }
    const out = await deps.runner.verifyTask(id, taskId)
    if ('skipped' in out) return fail(out.skipped)
    return { ok: true, note: `${out.verdict}: ${out.next}` }
  }

  /**
   * "Accept anyway": a person takes a task whose check was blocked as done.
   * The backend records who accepted it and why on the task (`manualOverride`)
   * and in the event log; it then merges like any verified task. Only a person
   * reaches this: the coordinator has no tool for it.
   */
  const acceptAnyway = async (
    id: string,
    taskId: string,
    by: string,
    reason?: string
  ): Promise<ActionResult> => {
    const { task } = await taskOf(id, taskId)
    if (!task) return fail(`no task ${taskId}`)
    if (!taskActionsOf(task).accept) {
      return fail(`task ${taskId} is ${task.status} and has no blocked check to accept`)
    }
    const who = by.trim()
    if (!who) return fail('say who is accepting it')
    await deps.api.transition(id, {
      task: {
        id: taskId,
        to: 'verified',
        patch: { accept: { by: who, reason: reason?.trim() || undefined } },
      },
    })
    // Verified means it can merge; the same step a passing check takes.
    await deps.runner.integrate(id)
    await deps.runner.kick(id)
    return { ok: true }
  }

  const handoff = async (id: string, taskId: string): Promise<string> => {
    const ctx = await deps.api.context(id, [taskId])
    return ctx.handoffs.find((h) => h.taskId === taskId)?.text ?? ''
  }

  const pause = async (id: string) => {
    await deps.api.transition(id, { campaign: 'paused' })
  }

  const resume = async (id: string) => {
    await deps.api.transition(id, { campaign: 'running' })
    await deps.runner.kick(id)
  }

  const cancel = async (id: string) => {
    await deps.runner.cancel(id)
  }

  /** The gate command the user is about to approve, for the confirm dialog. */
  const gateCommand = async (id: string) => deps.api.gatePlan(id)

  /**
   * Run the gate and create the one proposal. The caller has shown the gate
   * command and got the user's yes; this is the same step `campaign_merge
   * finalize=true` takes after its approval card.
   */
  const finalize = async (id: string): Promise<ActionResult> => {
    let c = await deps.api.get(id)
    if (c.status === 'running') c = (await deps.runner.integrate(id)).campaign
    if (c.status !== 'reviewing') return fail(`the campaign is ${c.status}, not reviewing`)
    const done = await deps.api.finalize(id)
    if (!done.gate.passed && !done.gate.skipped) {
      return fail('the gate failed; the campaign stays in review')
    }
    return {
      ok: true,
      note: done.warning ?? (done.proposalId ? `proposal ${done.proposalId}` : undefined),
    }
  }

  return {
    sendNote,
    stopTask,
    skipTask,
    retryTask,
    verifyAgain,
    acceptAnyway,
    handoff,
    pause,
    resume,
    cancel,
    gateCommand,
    finalize,
  }
}

export type BoardActions = ReturnType<typeof createBoardActions>
