import { describe, expect, it, vi } from 'vitest'
import {
  CANCELLED_BY_USER,
  cancelMessage,
  cancelTask,
  patchForOutcome,
  type CancelResult,
} from '@/lib/coworkCancel'
import type { ActivityTask } from '@/lib/coworkActivity'

const SESSION = 's-1'
const T0 = 1_700_000_000_000

const task = (over: Partial<ActivityTask> = {}): ActivityTask => ({
  id: 'call-1',
  sessionId: SESSION,
  workflowId: 'run-1',
  kind: 'agent',
  title: 'researcher',
  status: 'running',
  startedAt: T0,
  ...over,
})

const deps = (over: Partial<Parameters<typeof cancelTask>[2]> = {}) => ({
  abortAgent: vi.fn(() => true),
  killJob: vi.fn(async () => ({ jobId: 'bash-1', outcome: 'killed' as const })),
  ...over,
})

describe('cancelling a subagent', () => {
  it('aborts that child and reports it stopped', async () => {
    const d = deps()
    const result = await cancelTask(SESSION, task(), d)
    expect(d.abortAgent).toHaveBeenCalledWith(
      SESSION,
      'call-1',
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
