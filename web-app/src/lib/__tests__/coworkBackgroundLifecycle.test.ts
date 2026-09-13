import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import {
  emptyActivityState,
  findTaskByJob,
  isFinished,
  progressOf,
  settleOnLoad,
  startTask,
  startWorkflow,
  taskIdFor,
  updateTask,
  workflowStatus,
  type ActivityState,
  type ActivityTask,
} from '@/lib/coworkActivity'
import {
  MAX_KEPT_OUTPUT_CHARS,
  recordJobCollected,
  recordShellDispatch,
  recordShellOutcome,
  type RunContext,
} from '@/lib/coworkActivityRecorder'
import { collectedJobId, finishedJobPatch } from '@/lib/coworkTasks'
import { INTERRUPTED_BY_RESTART } from '@/lib/hydrateStores'

const T0 = 1_700_000_000_000
const A = 'session-a'
const B = 'session-b'

const task = (over: Partial<ActivityTask> & { id: string }): ActivityTask => {
  const sessionId = over.sessionId ?? A
  const workflowId = over.workflowId ?? 'run-1'
  return {
    callId: over.id,
    kind: 'shell',
    title: 'pnpm build',
    status: 'running',
    startedAt: T0,
    ...over,
    sessionId,
    workflowId,
    id: taskIdFor(sessionId, workflowId, over.id),
  }
}

const withTasks = (...tasks: ActivityTask[]): ActivityState =>
  tasks.reduce(
    (state, t) =>
      startTask(
        startWorkflow(state, {
          id: t.workflowId,
          sessionId: t.sessionId,
          title: 'run',
          startedAt: T0,
          phases: [],
        }),
        t
      ),
    emptyActivityState()
  )

describe('what a restart leaves behind', () => {
  it('marks live work interrupted by the application exit, never running', () => {
    const state = withTasks(
      task({ id: 'a', status: 'running', jobId: 'bash-x-1' }),
      task({ id: 'b', status: 'queued', kind: 'agent' }),
      task({ id: 'c', status: 'done', endedAt: T0 + 5 })
    )
    const settled = settleOnLoad(state, T0 + 100, INTERRUPTED_BY_RESTART)
    const a = settled.tasks[taskIdFor(A, 'run-1', 'a')]
    const b = settled.tasks[taskIdFor(A, 'run-1', 'b')]
    expect(a).toMatchObject({
      status: 'interrupted',
      detail: INTERRUPTED_BY_RESTART,
      endedAt: T0 + 100,
    })
    expect(a.jobId).toBeUndefined()
    expect(b.status).toBe('interrupted')
    // Finished work is history, untouched.
    expect(settled.tasks[taskIdFor(A, 'run-1', 'c')]).toMatchObject({
      status: 'done',
      endedAt: T0 + 5,
    })
    expect(isFinished('interrupted')).toBe(true)
  })

  it('reads records written before `interrupted` existed the same way', () => {
    // An older build settled a restart as cancelled with this reason.
    const old = withTasks(
      task({
        id: 'old',
        status: 'cancelled',
        detail: INTERRUPTED_BY_RESTART,
        endedAt: T0 + 7,
      }),
      task({ id: 'mine', status: 'cancelled', detail: 'cancelled:user' })
    )
    const settled = settleOnLoad(old, T0 + 100, INTERRUPTED_BY_RESTART)
    expect(settled.tasks[taskIdFor(A, 'run-1', 'old')]).toMatchObject({
      status: 'interrupted',
      // Its recorded end is kept, not replaced with this load's time.
      endedAt: T0 + 7,
    })
    // A cancellation someone made stays a cancellation.
    expect(settled.tasks[taskIdFor(A, 'run-1', 'mine')].status).toBe(
      'cancelled'
    )
  })

  it('never lets a late event bring interrupted work back', () => {
    const settled = settleOnLoad(
      withTasks(task({ id: 'a' })),
      T0 + 1,
      INTERRUPTED_BY_RESTART
    )
    const late = updateTask(settled, taskIdFor(A, 'run-1', 'a'), {
      status: 'done',
    })
    expect(late.tasks[taskIdFor(A, 'run-1', 'a')].status).toBe('interrupted')
  })

  it('reports an interrupted workflow as such, after a failure', () => {
    const wf = { id: 'run-1', sessionId: A, title: 'x', startedAt: T0, phases: [] }
    expect(
      workflowStatus(wf, [
        task({ id: 'a', status: 'interrupted' }),
        task({ id: 'b', status: 'cancelled' }),
      ])
    ).toBe('interrupted')
    expect(
      workflowStatus(wf, [
        task({ id: 'a', status: 'interrupted' }),
        task({ id: 'b', status: 'error' }),
      ])
    ).toBe('error')
    expect(
      progressOf([
        task({ id: 'a', status: 'interrupted' }),
        task({ id: 'b', status: 'done' }),
      ])
    ).toMatchObject({ interrupted: 1, finished: 2, fraction: 1 })
  })
})

describe('job identity is confined to its session', () => {
  it('finds a job only in the session that started it', () => {
    const state = withTasks(
      task({ id: 'a', sessionId: A, jobId: 'bash-7' }),
      task({ id: 'b', sessionId: B, jobId: 'bash-7' })
    )
    expect(findTaskByJob(state, 'bash-7', A)?.sessionId).toBe(A)
    expect(findTaskByJob(state, 'bash-7', B)?.sessionId).toBe(B)
    expect(findTaskByJob(state, 'bash-7', 'session-c')).toBeUndefined()
  })
})

describe('reading a finished job from the backend', () => {
  const job = {
    jobId: 'bash-1',
    command: 'x',
    elapsedMs: 10,
    finished: true,
    finishedAtMs: T0 + 9,
  }

  it('says how it ended', () => {
    expect(finishedJobPatch({ ...job, exitCode: 0 })).toMatchObject({
      status: 'done',
      exitCode: 0,
      endedAt: T0 + 9,
    })
    expect(finishedJobPatch({ ...job, exitCode: 2 })).toMatchObject({
      status: 'error',
      exitCode: 2,
    })
    expect(finishedJobPatch({ ...job, signalled: true })).toMatchObject({
      status: 'error',
      signalled: true,
    })
    expect(
      finishedJobPatch({ ...job, stoppedByRequest: true, signalled: true })
    ).toMatchObject({ status: 'cancelled' })
  })

  it('counts only a collection as the command’s output', () => {
    expect(collectedJobId({ job_id: 'bash-1' })).toBe('bash-1')
    expect(collectedJobId({ job_id: 'bash-1', action: 'await' })).toBe('bash-1')
    expect(collectedJobId({ job_id: 'bash-1', action: 'status' })).toBeUndefined()
    expect(collectedJobId({ job_id: 'bash-1', action: 'cancel' })).toBeUndefined()
    expect(collectedJobId({ action: 'list' })).toBeUndefined()
  })
})

describe('what a shell task keeps', () => {
  const run: RunContext = { sessionId: A, runId: 'run-1', title: 'build' }
  const id = (callId: string) => taskIdFor(A, 'run-1', callId)
  const store = () => useCoworkActivity.getState()

  beforeEach(() => {
    useCoworkActivity.setState(emptyActivityState())
  })

  it('never stores a credential from the command line or its output', () => {
    recordShellDispatch(run, {
      callId: 'c1',
      command: 'curl -H "Authorization: Bearer abcdefghijklmnop" -d token=sk-live_0123456789abcdefghij',
    })
    const started = store().tasks[id('c1')]
    expect(started.title).not.toContain('abcdefghijklmnop')
    expect(started.command).not.toContain('sk-live_')

    recordShellOutcome(run, 'c1', {
      output: 'connecting with PGPASSWORD=hunter2hunter2\n[exit 0]',
    })
    const done = store().tasks[id('c1')]
    expect(done.output).not.toContain('hunter2')
    expect(done.status).toBe('done')
    expect(done.exitCode).toBe(0)
  })

  it('reads failure from the exit marker, and keeps the end of a long log', () => {
    recordShellDispatch(run, { callId: 'c2', command: 'pnpm test' })
    const long = 'x'.repeat(MAX_KEPT_OUTPUT_CHARS + 500) + '\nFAIL src/a.test.ts\n[exit 1]'
    recordShellOutcome(run, 'c2', { output: long })
    const t = store().tasks[id('c2')]
    expect(t.status).toBe('error')
    expect(t.exitCode).toBe(1)
    expect(t.outputTruncated).toBe(true)
    expect(t.output!.length).toBeLessThanOrEqual(MAX_KEPT_OUTPUT_CHARS)
    expect(t.output!.endsWith('FAIL src/a.test.ts\n[exit 1]')).toBe(true)
  })

  it('ignores a collection from another session for the same job id', () => {
    recordShellDispatch(run, { callId: 'c3', command: 'sleep 60' })
    recordShellOutcome(run, 'c3', {
      output:
        'Command was started as a background job and is continuing in the background (job_id=bash-ab-3).',
    })
    expect(store().tasks[id('c3')]).toMatchObject({
      status: 'running',
      jobId: 'bash-ab-3',
    })
    recordJobCollected(B, 'bash-ab-3', { output: 'not yours\n[exit 0]' })
    expect(store().tasks[id('c3')].status).toBe('running')
    recordJobCollected(A, 'bash-ab-3', { output: 'slept\n[exit 0]' })
    expect(store().tasks[id('c3')]).toMatchObject({ status: 'done', output: 'slept\n[exit 0]' })
  })
})
