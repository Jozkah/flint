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

    recordJobCollected('bash-3', { output: 'built in 9m' })

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

    recordJobCollected('bash-3', { output: 'half a line before the kill' })

    const task = store().tasks[idOf('call-1')]
    expect(task.status).toBe('cancelled')
    expect(task.output).toBe('half a line before the kill')
  })

  it('is settled by a restart, which really does kill it', () => {
    // Unlike a turn ending, a restart takes the backend with it.
    backgroundCommand(run, 'call-1', 'bash-3')
    endRun(run)
    store().recoverOnLoad('interrupted:restart')
    expect(store().tasks[idOf('call-1')].status).toBe('cancelled')
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
