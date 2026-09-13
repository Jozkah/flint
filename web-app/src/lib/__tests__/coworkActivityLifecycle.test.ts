import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import {
  recordAgentDispatch,
  recordJobCollected,
  recordShellDispatch,
  recordShellOutcome,
  type RunContext,
} from '@/lib/coworkActivityRecorder'
import {
  INTERRUPTED_BY_RUN_END,
  emptyActivityState,
  findTaskByJob,
  sessionWorkflows,
  taskIdFor,
  workflowAnchoredAt,
} from '@/lib/coworkActivity'
import { CANCELLED_BY_USER } from '@/lib/coworkCancel'

/**
 * The lifecycle a run actually drives, in the order `runRequest` drives it.
 *
 * The defect these cover: the run's `finally` settled *every* live task in the
 * session as cancelled, including a shell command that had been backgrounded
 * and was still running. The record then said "cancelled" while the process
 * was alive, and because a finished task's status is protected from later
 * change, neither polling nor collection could ever repair it.
 */

const SESSION = 's-1'
const run: RunContext = {
  sessionId: SESSION,
  runId: 'run-1',
  title: 'build the thing',
  model: 'jan-nano-4b',
}
const second: RunContext = {
  sessionId: SESSION,
  runId: 'run-2',
  title: 'a later question',
}

const store = () => useCoworkActivity.getState()
const idOf = (callId: string, runId = run.runId) =>
  taskIdFor(SESSION, runId, callId)

/** Background a command the way the tool's timeout branch does. */
const backgroundCommand = (
  context: RunContext,
  callId: string,
  jobId: string
) => {
  recordShellDispatch(context, { callId, command: 'pnpm build' })
  recordShellOutcome(context, callId, {
    output: `Command exceeded 120s and is continuing in the background (job_id=${jobId}).`,
  })
}

/** What the route's `finally` does when a turn ends. */
const endRun = (context: RunContext) => {
  store().settleRun(context.runId, INTERRUPTED_BY_RUN_END)
  store().finishWorkflow(context.runId)
}

describe('a background shell job outliving its run', () => {
  beforeEach(() => {
    useCoworkActivity.setState(emptyActivityState())
    useCoworkSessions.setState({
      sessions: [
        {
          id: SESSION,
          title: 'session',
          folder: null,
          turns: [],
          messages: [],
          updated: 0,
        },
      ],
      currentId: SESSION,
    })
  })

  it('is still running after the turn that started it ends', () => {
    // The process is alive. Recording "cancelled" here is false at the moment
    // it is written, and unrepairable afterwards.
    backgroundCommand(run, 'call-1', 'bash-3')
    endRun(run)

    expect(store().tasks[idOf('call-1')]).toMatchObject({
      status: 'running',
      jobId: 'bash-3',
    })
  })

  it('keeps its workflow running while it runs', () => {
    // The model turn is over; the work is not, so neither is the workflow.
    backgroundCommand(run, 'call-1', 'bash-3')
    endRun(run)
    expect(sessionWorkflows(store(), SESSION)[0].status).toBe('running')
  })

  it('is completed later by the backend poll', () => {
    backgroundCommand(run, 'call-1', 'bash-3')
    endRun(run)

    // What the route's reconciliation does with a finished job.
    const task = findTaskByJob(store(), 'bash-3')!
    store().patchTask(task.id, { status: 'done', endedAt: 1 })

    expect(store().tasks[idOf('call-1')].status).toBe('done')
    expect(sessionWorkflows(store(), SESSION)[0].status).toBe('done')
  })

  it('records its output when the agent collects it', () => {
    backgroundCommand(run, 'call-1', 'bash-3')
    endRun(run)

    recordJobCollected(run.sessionId, 'bash-3', { output: 'built in 9m' })

    expect(store().tasks[idOf('call-1')]).toMatchObject({
      status: 'done',
      output: 'built in 9m',
    })
  })

  it('is cancelled when a cancellation actually succeeds', () => {
    backgroundCommand(run, 'call-1', 'bash-3')
    endRun(run)

    // What the route writes for a `cancelled` outcome.
    store().patchTask(idOf('call-1'), {
      status: 'cancelled',
      endedAt: 2,
      detail: CANCELLED_BY_USER,
    })

    expect(store().tasks[idOf('call-1')]).toMatchObject({
      status: 'cancelled',
      detail: CANCELLED_BY_USER,
    })
  })

  it('still hands over what it printed after being cancelled', () => {
    // Killing the job keeps its entry, so a later collection still lands.
    backgroundCommand(run, 'call-1', 'bash-3')
    endRun(run)
    store().patchTask(idOf('call-1'), {
      status: 'cancelled',
      endedAt: 2,
      detail: CANCELLED_BY_USER,
    })

    recordJobCollected(run.sessionId, 'bash-3', { output: 'half a line before the kill' })

    const task = store().tasks[idOf('call-1')]
    expect(task.status).toBe('cancelled')
    expect(task.output).toBe('half a line before the kill')
  })

  it('is settled by a restart, which really does kill it', () => {
    // Unlike a turn ending, a restart takes the backend with it.
    backgroundCommand(run, 'call-1', 'bash-3')
    endRun(run)
    store().recoverOnLoad('interrupted:restart')
    expect(store().tasks[idOf('call-1')].status).toBe('interrupted')
  })
})

describe('what a run ending does settle', () => {
  beforeEach(() => {
    useCoworkActivity.setState(emptyActivityState())
  })

  it('settles an agent task orphaned by the run', () => {
    // Its stream was torn down with the dispatch loop awaiting it; nothing
    // will ever report on it again.
    recordAgentDispatch(run, { callId: 'call-1', agentName: 'explorer' })
    store().patchTask(idOf('call-1'), { status: 'running' })

    endRun(run)

    expect(store().tasks[idOf('call-1')]).toMatchObject({
      status: 'cancelled',
      detail: INTERRUPTED_BY_RUN_END,
    })
  })

  it('settles a queued agent task that will never get its slot', () => {
    recordAgentDispatch(run, { callId: 'call-1', agentName: 'explorer' })
    endRun(run)
    expect(store().tasks[idOf('call-1')].status).toBe('cancelled')
  })

  it('settles a shell command still inside its tool call', () => {
    // No job id: the invoke carrying it is gone with the run.
    recordShellDispatch(run, { callId: 'call-1', command: 'pnpm build' })
    endRun(run)
    expect(store().tasks[idOf('call-1')].status).toBe('cancelled')
  })

  it('leaves another run’s live work alone', () => {
    // One turn ending says nothing about a second run in the same session.
    recordAgentDispatch(run, { callId: 'call-1', agentName: 'explorer' })
    store().patchTask(idOf('call-1'), { status: 'running' })
    recordAgentDispatch(second, { callId: 'call-2', agentName: 'verifier' })
    store().patchTask(idOf('call-2', second.runId), { status: 'running' })

    endRun(run)

    expect(store().tasks[idOf('call-1')].status).toBe('cancelled')
    expect(store().tasks[idOf('call-2', second.runId)].status).toBe('running')
  })

  it('leaves another run’s background job alone', () => {
    backgroundCommand(second, 'call-2', 'bash-9')
    recordAgentDispatch(run, { callId: 'call-1', agentName: 'explorer' })

    endRun(run)

    expect(store().tasks[idOf('call-2', second.runId)].status).toBe('running')
  })
})

describe('the inline card after a reload', () => {
  beforeEach(() => {
    useCoworkActivity.setState(emptyActivityState())
  })

  /** What comes back off disk: the record, with the actions rebuilt. */
  const reload = () => {
    const { workflows, tasks } = store()
    const persisted = JSON.parse(JSON.stringify({ workflows, tasks }))
    useCoworkActivity.setState(persisted)
    // Hydration settles whatever the previous app run left in flight.
    store().recoverOnLoad('interrupted:restart')
  }

  it('still anchors its workflow to the same message', () => {
    recordAgentDispatch(run, {
      callId: 'call-1',
      agentName: 'explorer',
      anchorMessageId: 's-1-asst-3',
    })
    store().patchTask(idOf('call-1'), { status: 'done', endedAt: 1 })

    reload()

    const view = workflowAnchoredAt(store(), SESSION, 's-1-asst-3')
    expect(view?.workflow.id).toBe(run.runId)
  })

  it('still points at a workflow the panel can focus by id', () => {
    recordAgentDispatch(run, {
      callId: 'call-1',
      agentName: 'explorer',
      anchorMessageId: 's-1-asst-3',
    })
    store().patchTask(idOf('call-1'), { status: 'done', endedAt: 1 })
    reload()

    const view = workflowAnchoredAt(store(), SESSION, 's-1-asst-3')!
    // The id the card hands the panel names a workflow the panel still has.
    expect(
      sessionWorkflows(store(), SESSION).some(
        (one) => one.workflow.id === view.workflow.id
      )
    ).toBe(true)
  })

  it('keeps two runs of the same question apart across a reload', () => {
    // Identical titles; only the ids and anchors tell them apart.
    recordAgentDispatch(run, {
      callId: 'call-1',
      agentName: 'explorer',
      anchorMessageId: 's-1-asst-3',
    })
    recordAgentDispatch(
      { ...run, runId: 'run-3' },
      { callId: 'call-1', agentName: 'explorer', anchorMessageId: 's-1-asst-9' }
    )
    store().patchTask(idOf('call-1'), { status: 'done', endedAt: 1 })
    store().patchTask(idOf('call-1', 'run-3'), { status: 'done', endedAt: 1 })

    reload()

    expect(
      workflowAnchoredAt(store(), SESSION, 's-1-asst-3')?.workflow.id
    ).toBe(run.runId)
    expect(
      workflowAnchoredAt(store(), SESSION, 's-1-asst-9')?.workflow.id
    ).toBe('run-3')
  })

  it('survives even after the workflow was cleared from the panel', () => {
    // Clearing hides a finished workflow from the panel's lists; the card is a
    // record of the conversation and stays.
    recordAgentDispatch(run, {
      callId: 'call-1',
      agentName: 'explorer',
      anchorMessageId: 's-1-asst-3',
    })
    store().patchTask(idOf('call-1'), { status: 'done', endedAt: 1 })
    store().finishWorkflow(run.runId)
    store().clearFinished(SESSION)
    reload()

    expect(sessionWorkflows(store(), SESSION)).toEqual([])
    expect(
      workflowAnchoredAt(store(), SESSION, 's-1-asst-3')?.workflow.id
    ).toBe(run.runId)
  })
})

describe('how a dispatched subagent is recorded when it ends', () => {
  beforeEach(() => {
    useCoworkActivity.setState(emptyActivityState())
  })

  /**
   * The route's own sequence. `runSubagent` calls `onEnd` for *every* ending —
   * an abort before the child starts, a failed model step, an exhausted step
   * budget — so `onEnd` records usage only, and the terminal status comes from
   * the outcome once the call returns.
   */
  const runChild = (
    callId: string,
    outcome: { isError: boolean; output: string; aborted?: boolean }
  ) => {
    recordAgentDispatch(run, { callId, agentName: 'explorer' })
    const id = idOf(callId)
    store().patchTask(id, { status: 'running' })
    // onEnd: usage only.
    store().patchTask(id, { usage: { total_tokens: 120 } })
    // settleChild: the real outcome.
    store().patchTask(id, {
      output: outcome.output,
      status: outcome.aborted
        ? 'cancelled'
        : outcome.isError
          ? 'error'
          : 'done',
      endedAt: 10,
      ...(outcome.aborted ? { detail: CANCELLED_BY_USER } : {}),
    })
    return id
  }

  it('records a failed subagent as failed, not as done', () => {
    const id = runChild('call-1', { isError: true, output: 'model step failed' })
    expect(store().tasks[id]).toMatchObject({
      status: 'error',
      output: 'model step failed',
    })
    expect(sessionWorkflows(store(), SESSION)[0].status).toBe('error')
  })

  it('records a stopped subagent as cancelled, not as done', () => {
    const id = runChild('call-1', {
      isError: true,
      output: '(the subagent was cancelled)',
      aborted: true,
    })
    expect(store().tasks[id]).toMatchObject({
      status: 'cancelled',
      detail: CANCELLED_BY_USER,
    })
    expect(sessionWorkflows(store(), SESSION)[0].status).toBe('cancelled')
  })

  it('records a successful subagent as done, with its usage', () => {
    const id = runChild('call-1', { isError: false, output: 'the answer' })
    expect(store().tasks[id]).toMatchObject({
      status: 'done',
      output: 'the answer',
    })
    expect(store().tasks[id].usage?.total_tokens).toBe(120)
  })

  it('counts a failure as a failure in the workflow’s progress', () => {
    // Recorded as `done`, a failed child made the run look entirely
    // successful: error 0, cancelled 0, the bar full.
    runChild('call-1', { isError: true, output: 'boom' })
    runChild('call-2', { isError: false, output: 'fine' })
    const progress = sessionWorkflows(store(), SESSION)[0].progress
    expect(progress).toMatchObject({ done: 1, error: 1, cancelled: 0 })
  })

  it('keeps a status the panel’s own Stop already recorded', () => {
    // The per-task Stop settles the row while the child is still unwinding;
    // the outcome that arrives afterwards must not overwrite it.
    recordAgentDispatch(run, { callId: 'call-1', agentName: 'explorer' })
    const id = idOf('call-1')
    store().patchTask(id, { status: 'running' })
    store().patchTask(id, {
      status: 'cancelled',
      endedAt: 5,
      detail: CANCELLED_BY_USER,
    })
    store().patchTask(id, { status: 'error', endedAt: 10, output: 'late' })

    expect(store().tasks[id]).toMatchObject({
      status: 'cancelled',
      endedAt: 5,
      output: 'late',
    })
  })
})
