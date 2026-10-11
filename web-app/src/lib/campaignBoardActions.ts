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
import { isServerDriven, type Campaign } from '@/lib/campaignModel'
import { interruptRun, steerRun } from '@/lib/remoteRunner'
import { dependantsOf, taskActionsOf } from '@/lib/campaignView'
import { messageIdOf } from '@/lib/campaignNotes'
import { retryHintDetail } from '@/lib/campaignSeed'

/**
 * Backend commands that arrive with the campaign recovery work. Each one is
 * used when the api has it; the board says so plainly when it does not.
 */
export type RecoveryApi = Partial<{
  /** Run the final build and test check again on the integration branch. */
  retryGate: (id: string) => Promise<unknown>
  /** Create the repair task for a failed final check. */
  repairGate: (id: string) => Promise<unknown>
  /** Skip a task and everything that waits on it. */
  skipCascade: (id: string, taskId: string) => Promise<unknown>
  /** Let the tasks that wait on a skipped task run without it. */
  releaseDependants: (id: string, taskId: string) => Promise<unknown>
}>

/**
 * What a campaign the server drives needs instead of the renderer's own
 * runner: the task moves are the server driver's commands (`campaignApi`),
 * and a run is steered or stopped through the server's session commands.
 */
export type ServerBoardDeps = {
  steer: (sessionId: string, text: string) => Promise<unknown>
  interrupt: (sessionId: string) => Promise<unknown>
}

const serverRunDeps: ServerBoardDeps = {
  steer: (sessionId, text) => steerRun(sessionId, text),
  interrupt: (sessionId) => interruptRun(sessionId),
}

export type BoardDeps = {
  api: Pick<
    CampaignApi,
    'get' | 'transition' | 'context' | 'gatePlan' | 'finalize' | 'refresh'
  > &
    RecoveryApi &
    Partial<
      Pick<
        CampaignApi,
        | 'retryTask'
        | 'acceptAnyway'
        | 'verifyAgain'
        | 'resolveTask'
        | 'skipTask'
        | 'cancel'
      >
    >
  /** Replaces the live session commands of a server campaign (tests). */
  server?: ServerBoardDeps
  runner: {
    kick: (id: string) => Promise<unknown>
    cancel: (id: string, detail?: string) => Promise<Campaign>
    /** Start the conflict resolver for the named conflicted tasks. */
    resolve?: (
      id: string,
      taskIds?: string[]
    ) => Promise<{ taskId: string; started: boolean; reason?: string }[]>
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
  // Read at call time, so a test (or a host) may set `deps.server` late.
  const serverRun: ServerBoardDeps = {
    steer: (sessionId, text) => (deps.server ?? serverRunDeps).steer(sessionId, text),
    interrupt: (sessionId) => (deps.server ?? serverRunDeps).interrupt(sessionId),
  }
  /** A campaign the server drives: its moves are the server's commands. */
  const onServer = async (id: string) => isServerDriven(await deps.api.get(id))
  const needs = <K extends keyof BoardDeps['api']>(name: K) => {
    const fn = deps.api[name]
    if (!fn) throw new Error(`this app cannot ask the server to ${String(name)}`)
    return fn as NonNullable<BoardDeps['api'][K]>
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
    if (isServerDriven(c)) {
      // The task's session lives on the server: the note goes into its turn.
      await serverRun.steer(task.sessionId, note)
      return { ok: true, note: 'sent' }
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
    const { c, task } = await taskOf(id, taskId)
    if (!task) return fail(`no task ${taskId}`)
    if (!taskActionsOf(task).stop) return fail(`task ${taskId} is ${task.status}`)
    if (isServerDriven(c)) {
      // A live run is interrupted and the driver settles it as cancelled; a
      // task that is not running is skipped through the driver.
      if (task.sessionId && taskActionsOf(task).note) {
        await serverRun.interrupt(task.sessionId)
      } else {
        await needs('skipTask')(id, taskId, 'leave')
      }
      return { ok: true }
    }
    if (task.sessionId && deps.liveSessions().has(task.sessionId)) {
      deps.abortRun(task.sessionId)
      return { ok: true }
    }
    await deps.api.transition(id, { task: { id: taskId, to: 'cancelled' } })
    return { ok: true }
  }

  const skipTask = async (id: string, taskId: string): Promise<ActionResult> => {
    const { c, task } = await taskOf(id, taskId)
    if (!task) return fail(`no task ${taskId}`)
    if (!taskActionsOf(task).skip) {
      return fail(`task ${taskId} is ${task.status} and cannot be skipped`)
    }
    if (isServerDriven(c)) {
      await needs('skipTask')(id, taskId, 'leave')
      return { ok: true }
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
    const { c, task } = await taskOf(id, taskId)
    if (!task) return fail(`no task ${taskId}`)
    if (!taskActionsOf(task).retry) {
      return fail(`task ${taskId} is ${task.status} and cannot be retried`)
    }
    if (isServerDriven(c)) {
      await needs('retryTask')(id, taskId, hint)
      return { ok: true }
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
    const { c, task } = await taskOf(id, taskId)
    if (!task) return fail(`no task ${taskId}`)
    if (!taskActionsOf(task).verify) {
      return fail(`task ${taskId} is ${task.status}, so it is not waiting to be checked`)
    }
    if (isServerDriven(c)) {
      // The server runs the check in the background; the board shows it.
      await needs('verifyAgain')(id, taskId)
      return { ok: true, note: 'checking again' }
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
    const { c, task } = await taskOf(id, taskId)
    if (!task) return fail(`no task ${taskId}`)
    if (!taskActionsOf(task).accept) {
      return fail(`task ${taskId} is ${task.status} and has no blocked check to accept`)
    }
    const who = by.trim()
    if (!who) return fail('say who is accepting it')
    if (isServerDriven(c)) {
      // The server names the signed-in client itself, and wants a reason.
      if (!reason?.trim()) return fail('say why you accept it without a passing check')
      await needs('acceptAnyway')(id, taskId, who, reason.trim())
      return { ok: true }
    }
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

  /**
   * "Try to resolve automatically": starts the conflict resolver for a task in
   * conflict. The backend moves it conflict -> resolving -> merged (or back to
   * conflict with the files it could not settle); the board shows the states.
   */
  const resolveConflict = async (id: string, taskId: string): Promise<ActionResult> => {
    const { c, task } = await taskOf(id, taskId)
    if (!task) return fail(`no task ${taskId}`)
    if (!taskActionsOf(task).resolve) {
      return fail(`task ${taskId} is ${task.status}, not in conflict`)
    }
    if (isServerDriven(c)) {
      await needs('resolveTask')(id, taskId)
      return { ok: true }
    }
    if (!deps.runner.resolve) return fail('the resolver is not available here')
    const [out] = await deps.runner.resolve(id, [taskId])
    if (out && !out.started) {
      return fail(out.reason ?? 'the resolver could not start')
    }
    return { ok: true }
  }

  /**
   * "Skip this too": skips the task and every task that waits on it, so
   * nothing is left waiting for work that will never merge.
   */
  const skipCascade = async (id: string, taskId: string): Promise<ActionResult> => {
    if (deps.api.skipCascade) {
      await deps.api.skipCascade(id, taskId)
      // A server campaign is kicked by its own driver.
      if (!(await onServer(id))) await deps.runner.kick(id)
      return { ok: true }
    }
    const { c, task } = await taskOf(id, taskId)
    if (!task) return fail(`no task ${taskId}`)
    if (task.status !== 'cancelled') {
      const can = taskActionsOf(task)
      if (!can.skip && !can.stop) {
        return fail(`task ${taskId} is ${task.status} and cannot be skipped`)
      }
      await deps.api.transition(id, { task: { id: taskId, to: 'cancelled' } })
    }
    for (const t of dependantsOf(taskId, c.tasks)) {
      await deps.api.transition(id, { task: { id: t.id, to: 'cancelled' } })
    }
    await deps.runner.kick(id)
    return { ok: true }
  }

  /**
   * "Run without it": the tasks that waited on a skipped task stop waiting
   * for it and start.
   */
  const releaseDependants = async (
    id: string,
    taskId: string
  ): Promise<ActionResult> => {
    if (!deps.api.releaseDependants) {
      return fail('this version cannot run a task without the one it waited for')
    }
    await deps.api.releaseDependants(id, taskId)
    if (!(await onServer(id))) await deps.runner.kick(id)
    return { ok: true }
  }

  /** "Run checks again": the final build and test check, once more. */
  const retryGate = async (id: string): Promise<ActionResult> => {
    if (!deps.api.retryGate) {
      return fail('this version cannot run the checks again from here')
    }
    await deps.api.retryGate(id)
    return { ok: true }
  }

  /** "Fix it automatically": a repair task for what the final check found. */
  const fixChecks = async (id: string): Promise<ActionResult> => {
    if (!deps.api.repairGate) {
      return fail('this version cannot start the repair from here')
    }
    await deps.api.repairGate(id)
    if (!(await onServer(id))) await deps.runner.kick(id)
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
    if (!(await onServer(id))) await deps.runner.kick(id)
  }

  const cancel = async (id: string) => {
    // The server's driver stops its own runs.
    if (deps.api.cancel && (await onServer(id))) {
      await deps.api.cancel(id)
      return
    }
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
    // The server's driver merges by itself; only a renderer campaign is nudged.
    if (c.status === 'running' && !isServerDriven(c)) {
      c = (await deps.runner.integrate(id)).campaign
    }
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
    skipCascade,
    releaseDependants,
    retryGate,
    fixChecks,
    retryTask,
    verifyAgain,
    acceptAnyway,
    resolveConflict,
    handoff,
    pause,
    resume,
    cancel,
    gateCommand,
    finalize,
  }
}

export type BoardActions = ReturnType<typeof createBoardActions>
