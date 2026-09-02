import { describe, expect, it, vi } from 'vitest'
import {
  CANCELLED_BY_USER,
  cancelMessage,
  cancelTask,
  cancelWorkflow,
  patchForOutcome,
  type CancelResult,
} from '@/lib/coworkCancel'
import {
  progressOf,
  taskIdFor,
  workflowStatus,
  type ActivityTask,
  type WorkflowView,
} from '@/lib/coworkActivity'

const SESSION = 's-1'
const T0 = 1_700_000_000_000

const WORKFLOW = 'run-1'

const task = (over: Partial<ActivityTask> = {}): ActivityTask => {
  const callId = over.callId ?? over.id ?? 'call-1'
  const sessionId = over.sessionId ?? SESSION
  const workflowId = over.workflowId ?? WORKFLOW
  return {
    id: taskIdFor(sessionId, workflowId, callId),
    callId,
    sessionId,
    workflowId,
    kind: 'agent',
    title: 'researcher',
    status: 'running',
    startedAt: T0,
    ...over,
    // Re-applied after the spread: the identity is derived, never overridden.
    id: taskIdFor(sessionId, workflowId, callId),
    callId,
    sessionId,
    workflowId,
  } as ActivityTask
}

/** A workflow view over the given tasks, as a surface would receive it. */
const view = (tasks: ActivityTask[]): WorkflowView => {
  const workflow = {
    id: WORKFLOW,
    sessionId: SESSION,
    title: 'refactor the parser',
    startedAt: T0,
    phases: [],
  }
  return {
    workflow,
    tasks,
    status: workflowStatus(workflow, tasks),
    progress: progressOf(tasks),
    phases: [],
    unphased: tasks,
  }
}

const deps = (over: Partial<Parameters<typeof cancelTask>[2]> = {}) => ({
  abortAgent: vi.fn(() => true),
  killJob: vi.fn(async () => ({ jobId: 'bash-1', outcome: 'killed' as const })),
  ...over,
})

describe('cancelling a subagent', () => {
  it('aborts that child and reports it stopped', async () => {
    const d = deps()
    const result = await cancelTask(SESSION, task(), d)
    // Keyed by the canonical id, not the provider's call id: two runs of one
    // session can reuse a call id, and each has its own controller.
    expect(d.abortAgent).toHaveBeenCalledWith(
      SESSION,
      taskIdFor(SESSION, WORKFLOW, 'call-1'),
      CANCELLED_BY_USER
    )
    expect(result.outcome).toBe('cancelled')
  })

  it('says nothing was running when the run no longer holds it', async () => {
    // The child finished between the render and the click; claiming a
    // cancellation would be a claim the app cannot back up.
    const d = deps({ abortAgent: vi.fn(() => false) })
    expect((await cancelTask(SESSION, task(), d)).outcome).toBe('notRunning')
  })

  it('never signals a task that has already finished', async () => {
    const d = deps()
    const result = await cancelTask(SESSION, task({ status: 'done' }), d)
    expect(result.outcome).toBe('alreadyFinished')
    expect(d.abortAgent).not.toHaveBeenCalled()
  })

  it('never re-signals a task that was already cancelled', async () => {
    const d = deps()
    const result = await cancelTask(SESSION, task({ status: 'cancelled' }), d)
    expect(result.outcome).toBe('alreadyFinished')
    expect(d.abortAgent).not.toHaveBeenCalled()
  })
})

describe('cancelling a shell command', () => {
  const shell = (over: Partial<ActivityTask> = {}) =>
    task({ kind: 'shell', title: 'sleep 300', ...over })

  it('kills the backend job and reports it stopped', async () => {
    const d = deps()
    const result = await cancelTask(SESSION, shell({ jobId: 'bash-1' }), d)
    expect(d.killJob).toHaveBeenCalledWith('bash-1')
    expect(result.outcome).toBe('cancelled')
  })

  it('says a command still inside its tool call cannot be reached', async () => {
    // No job id means the backend has nothing registered: `execute_tool` takes
    // no cancellation token, so there is genuinely nothing to signal.
    const d = deps()
    const result = await cancelTask(SESSION, shell(), d)
    expect(result.outcome).toBe('unreachable')
    expect(d.killJob).not.toHaveBeenCalled()
  })

  it('passes on the backend’s verdict rather than assuming one', async () => {
    const cases = [
      ['alreadyFinished', 'alreadyFinished'],
      ['unknown', 'notRunning'],
      ['noPid', 'notRunning'],
    ] as const
    for (const [backend, expected] of cases) {
      const d = deps({
        killJob: vi.fn(async () => ({ jobId: 'bash-1', outcome: backend })),
      })
      const result = await cancelTask(SESSION, shell({ jobId: 'bash-1' }), d)
      expect(result.outcome).toBe(expected)
    }
  })

  it('reports a failed attempt as a failure, with what went wrong', async () => {
    const d = deps({
      killJob: vi.fn(async () => {
        throw new Error('the backend is gone')
      }),
    })
    const result = await cancelTask(SESSION, shell({ jobId: 'bash-1' }), d)
    expect(result).toMatchObject({
      outcome: 'failed',
      error: 'the backend is gone',
    })
  })
})

describe('what the record should say afterwards', () => {
  it('marks a task cancelled only when something was actually stopped', () => {
    expect(
      patchForOutcome({ taskId: 'call-1', outcome: 'cancelled' }, T0)
    ).toEqual({ status: 'cancelled', endedAt: T0, detail: CANCELLED_BY_USER })
  })

  it('leaves the row alone for every outcome that stopped nothing', () => {
    for (const outcome of [
      'alreadyFinished',
      'notRunning',
      'unreachable',
      'failed',
    ] as const) {
      expect(patchForOutcome({ taskId: 'call-1', outcome }, T0)).toBeNull()
    }
  })
})

describe('what the user is told', () => {
  const t = (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key} ${JSON.stringify(opts)}` : key

  it('names the reason rather than saying "could not cancel"', () => {
    const message = (outcome: CancelResult['outcome'], error?: string) =>
      cancelMessage({ taskId: 'call-1', outcome, error }, t)

    expect(message('alreadyFinished')).toBe('common:tasks.cancelAlreadyFinished')
    expect(message('unreachable')).toBe('common:tasks.cancelUnreachable')
    expect(message('notRunning')).toBe('common:tasks.cancelNotRunning')
    expect(message('failed', 'boom')).toContain('boom')
  })
})

describe('stopping a whole workflow', () => {
  const shell = (over: Partial<ActivityTask> = {}) =>
    task({ kind: 'shell', title: 'pnpm build', ...over })

  it('stops every reachable child', async () => {
    const d = deps()
    const result = await cancelWorkflow(
      SESSION,
      view([
        task({ id: 'a' }),
        task({ id: 'b' }),
        shell({ id: 'c', jobId: 'bash-1' }),
      ]),
      { deps: d }
    )
    expect(result.cancelled).toBe(3)
    expect(result.failed).toBe(0)
    expect(d.abortAgent).toHaveBeenCalledTimes(2)
    expect(d.killJob).toHaveBeenCalledTimes(1)
  })

  it('leaves already-finished children exactly as they were', async () => {
    // Their transcript, output and usage are the record of what happened.
    const d = deps()
    const result = await cancelWorkflow(
      SESSION,
      view([
        task({ id: 'a', status: 'done', output: 'the answer' }),
        task({ id: 'b' }),
      ]),
      { deps: d }
    )
    expect(result.results.map((r) => r.taskId)).toEqual([
      taskIdFor(SESSION, WORKFLOW, 'b'),
    ])
    expect(d.abortAgent).toHaveBeenCalledTimes(1)
  })

  it('reports a partial failure honestly', async () => {
    // One child refuses to die. Saying "stopped" would be a claim the app
    // cannot back up.
    const d = deps({
      abortAgent: vi.fn((_sid: string, taskId: string) =>
        taskId !== taskIdFor(SESSION, WORKFLOW, 'b')
      ),
    })
    const result = await cancelWorkflow(
      SESSION,
      view([task({ id: 'a' }), task({ id: 'b' })]),
      { deps: d }
    )
    expect(result.cancelled).toBe(1)
    expect(result.failed).toBe(1)
  })

  it('reaches agents and background commands together', async () => {
    const d = deps()
    await cancelWorkflow(
      SESSION,
      view([task({ id: 'a' }), shell({ id: 'b', jobId: 'bash-7' })]),
      { deps: d }
    )
    expect(d.abortAgent).toHaveBeenCalledOnce()
    expect(d.killJob).toHaveBeenCalledWith('bash-7')
  })

  it('skips a foreground command it cannot reach', async () => {
    // No job id, so there is nothing to signal; attempting it would only
    // produce an `unreachable` result to explain away.
    const d = deps()
    const result = await cancelWorkflow(SESSION, view([shell({ id: 'a' })]), {
      deps: d,
    })
    expect(result.results).toEqual([])
    expect(d.killJob).not.toHaveBeenCalled()
  })

  it('touches only the workflow it was given', async () => {
    // The view carries one workflow's tasks; a second run in the same session
    // is simply not in it.
    const d = deps()
    const result = await cancelWorkflow(SESSION, view([task({ id: 'a' })]), {
      deps: d,
    })
    expect(d.abortAgent).toHaveBeenCalledWith(
      SESSION,
      taskIdFor(SESSION, WORKFLOW, 'a'),
      CANCELLED_BY_USER
    )
    expect(result.results).toHaveLength(1)
  })

  it('keeps two identically named workflows apart', async () => {
    // Same title, different runs. Identity is the id, never the display name.
    const d = deps()
    const other: WorkflowView = {
      ...view([task({ id: 'a', workflowId: 'run-2' })]),
      workflow: {
        id: 'run-2',
        sessionId: SESSION,
        title: 'refactor the parser',
        startedAt: T0,
        phases: [],
      },
    }
    const result = await cancelWorkflow(SESSION, other, { deps: d })
    expect(result.workflowId).toBe('run-2')
    expect(d.abortAgent).toHaveBeenCalledWith(
      SESSION,
      taskIdFor(SESSION, 'run-2', 'a'),
      CANCELLED_BY_USER
    )
  })

  it('reports the second attempt as having nothing left to stop', async () => {
    // The first attempt took the controllers; the second finds none.
    let stopped = false
    const d = deps({
      abortAgent: vi.fn(() => {
        if (stopped) return false
        stopped = true
        return true
      }),
    })
    const target = view([task({ id: 'a' })])
    expect((await cancelWorkflow(SESSION, target, { deps: d })).cancelled).toBe(1)
    expect((await cancelWorkflow(SESSION, target, { deps: d })).failed).toBe(1)
  })

  it('reports nothing to do for a workflow with no live children', async () => {
    const d = deps()
    const result = await cancelWorkflow(
      SESSION,
      view([task({ id: 'a', status: 'done' })]),
      { deps: d }
    )
    expect(result).toMatchObject({ cancelled: 0, failed: 0, results: [] })
  })
})

describe('a kill the system refuses', () => {
  it('is reported as a failure carrying the reason', async () => {
    const d = deps({
      killJob: vi.fn(async () => ({
        jobId: 'bash-1',
        outcome: 'failed' as const,
        error: 'not permitted to signal this process group',
      })),
    })
    const result = await cancelTask(
      SESSION,
      task({ kind: 'shell', jobId: 'bash-1' }),
      d
    )
    expect(result).toMatchObject({
      outcome: 'failed',
      error: 'not permitted to signal this process group',
    })
    // Not marked cancelled: the command is still running.
    expect(patchForOutcome(result, T0)).toBeNull()
  })
})
