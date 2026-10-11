import { describe, it, expect, vi } from 'vitest'
import { createBoardActions, type BoardDeps } from '../campaignBoardActions'
import type {
  Campaign,
  CampaignTask,
  CampaignTaskStatus,
} from '../campaignModel'

const task = (
  id: string,
  status: CampaignTaskStatus,
  over: Partial<CampaignTask> = {}
): CampaignTask => ({
  id,
  title: id,
  brief: '',
  acceptance: [],
  paths: [],
  dependsOn: [],
  status,
  attempt: 0,
  tokensUsed: 0,
  detail: '',
  sessionId: `s-${id}`,
  ...over,
})

function setup(
  tasks: CampaignTask[],
  over: Partial<Campaign> = {},
  live: string[] = []
) {
  const c = {
    id: 'c1',
    title: 'C',
    coordinatorSession: 'coord',
    status: 'running',
    tasks,
    ...over,
  } as Campaign
  const api = {
    get: vi.fn(async () => c),
    transition: vi.fn(async () => c),
    context: vi.fn(async () => ({
      decisions: '',
      handoffs: [{ taskId: 'a', text: 'handoff text' }],
    })),
    gatePlan: vi.fn(async () => ({ source: 'detected', command: 'yarn test' })),
    finalize: vi.fn(async () => ({
      gate: { passed: true, skipped: false },
      proposalId: 'p1',
      files: 2,
      warning: null,
      campaign: c,
    })),
    refresh: vi.fn(async () => c),
  }
  const runner = {
    kick: vi.fn(async () => ({})),
    cancel: vi.fn(async () => c),
    integrate: vi.fn(async () => ({ campaign: c })),
    verifyTask: vi.fn(async () => ({ next: 'verified', verdict: 'PASS' })),
  }
  const deps = {
    api,
    runner,
    sendMessage: vi.fn(async () => ({ ok: true as const, output: 'sent' })),
    abortRun: vi.fn(),
    liveSessions: () => new Set(live),
  } as unknown as BoardDeps
  return { actions: createBoardActions(deps), api, runner, deps }
}

describe('board actions', () => {
  it('sends a note from the coordinator to a live task session', async () => {
    const { actions, deps } = setup([task('a', 'running')])
    expect(await actions.sendNote('c1', 'a', ' hello ')).toEqual({
      ok: true,
      note: 'sent',
    })
    expect(deps.sendMessage).toHaveBeenCalledWith('coord', 's-a', 'hello')
  })

  it('refuses a note to a task that is not running, and an empty note', async () => {
    const { actions, deps } = setup([task('a', 'merged')])
    expect(await actions.sendNote('c1', 'a', 'x')).toMatchObject({ ok: false })
    expect(await actions.sendNote('c1', 'a', '  ')).toMatchObject({ ok: false })
    expect(deps.sendMessage).not.toHaveBeenCalled()
  })

  it('stops a live run by aborting it, not by moving the record', async () => {
    const { actions, deps, api } = setup([task('a', 'running')], {}, ['s-a'])
    await actions.stopTask('c1', 'a')
    expect(deps.abortRun).toHaveBeenCalledWith('s-a')
    expect(api.transition).not.toHaveBeenCalled()
  })

  it('stops a queued task by cancelling it', async () => {
    const { actions, deps, api } = setup([
      task('a', 'queued', { sessionId: null }),
    ])
    await actions.stopTask('c1', 'a')
    expect(deps.abortRun).not.toHaveBeenCalled()
    expect(api.transition).toHaveBeenCalledWith('c1', {
      task: { id: 'a', to: 'cancelled' },
    })
  })

  it('retries a failed task through queued and kicks the scheduler', async () => {
    const { actions, api, runner } = setup([task('a', 'failed')])
    expect((await actions.retryTask('c1', 'a')).ok).toBe(true)
    expect(api.transition).toHaveBeenCalledWith('c1', {
      task: { id: 'a', to: 'queued' },
    })
    expect(runner.kick).toHaveBeenCalledWith('c1')
  })

  it('sends a retry hint with the retry, trimmed and capped', async () => {
    const { actions, api } = setup([task('a', 'failed')])
    await actions.retryTask('c1', 'a', '  use the sync fs api  ')
    expect(api.transition).toHaveBeenCalledWith('c1', {
      task: { id: 'a', to: 'queued', patch: { detail: 'hint: use the sync fs api' } },
    })
  })

  it('does not retry past the cap or retry a running task', async () => {
    const { actions, api } = setup([
      task('a', 'failed', { attempt: 2 }),
      task('b', 'running'),
    ])
    expect((await actions.retryTask('c1', 'a')).ok).toBe(false)
    expect((await actions.retryTask('c1', 'b')).ok).toBe(false)
    expect(api.transition).not.toHaveBeenCalled()
  })

  it('skips only skippable tasks', async () => {
    const { actions, api } = setup([task('a', 'conflict'), task('b', 'running')])
    expect((await actions.skipTask('c1', 'a')).ok).toBe(true)
    expect((await actions.skipTask('c1', 'b')).ok).toBe(false)
    expect(api.transition).toHaveBeenCalledTimes(1)
  })

  it('pauses, resumes and cancels through the backend and runner', async () => {
    const { actions, api, runner } = setup([task('a', 'running')])
    await actions.pause('c1')
    expect(api.transition).toHaveBeenLastCalledWith('c1', {
      campaign: 'paused',
    })
    await actions.resume('c1')
    expect(api.transition).toHaveBeenLastCalledWith('c1', {
      campaign: 'running',
    })
    expect(runner.kick).toHaveBeenCalled()
    await actions.cancel('c1')
    expect(runner.cancel).toHaveBeenCalledWith('c1')
  })

  it('checks a finished task again, only while it is waiting to be checked', async () => {
    const { actions, runner } = setup([
      task('a', 'completed', { verdict: 'BLOCKED' }),
      task('b', 'running'),
    ])
    expect(await actions.verifyAgain('c1', 'a')).toEqual({
      ok: true,
      note: 'PASS: verified',
    })
    expect(runner.verifyTask).toHaveBeenCalledWith('c1', 'a')
    expect((await actions.verifyAgain('c1', 'b')).ok).toBe(false)
    expect(runner.verifyTask).toHaveBeenCalledTimes(1)
  })

  it('accepts a blocked check anyway, with who and why, then merges', async () => {
    const { actions, api, runner } = setup([
      task('a', 'completed', { verdict: 'BLOCKED' }),
      task('b', 'completed', { verdict: 'FAIL' }),
      task('c', 'running'),
    ])
    const done = await actions.acceptAnyway('c1', 'a', ' jozkah ', ' read the diff ')
    expect(done.ok).toBe(true)
    expect(api.transition).toHaveBeenCalledWith('c1', {
      task: {
        id: 'a',
        to: 'verified',
        patch: { accept: { by: 'jozkah', reason: 'read the diff' } },
      },
    })
    expect(runner.integrate).toHaveBeenCalledWith('c1')
    // Only a blocked check can be accepted; nobody is not a name.
    expect((await actions.acceptAnyway('c1', 'b', 'me')).ok).toBe(false)
    expect((await actions.acceptAnyway('c1', 'c', 'me')).ok).toBe(false)
    expect((await actions.acceptAnyway('c1', 'a', '  ')).ok).toBe(false)
    expect(api.transition).toHaveBeenCalledTimes(1)
  })

  it('reads a handoff and the gate command', async () => {
    const { actions } = setup([task('a', 'completed')])
    expect(await actions.handoff('c1', 'a')).toBe('handoff text')
    expect(await actions.gateCommand('c1')).toMatchObject({
      command: 'yarn test',
    })
  })

  it('finalizes only a campaign that is reviewing', async () => {
    const reviewing = setup([task('a', 'merged')], { status: 'reviewing' })
    const ok = await reviewing.actions.finalize('c1')
    expect(ok).toMatchObject({ ok: true, note: 'proposal p1' })
    expect(reviewing.api.finalize).toHaveBeenCalledWith('c1')

    const running = setup([task('a', 'running')], { status: 'running' })
    expect((await running.actions.finalize('c1')).ok).toBe(false)
    expect(running.api.finalize).not.toHaveBeenCalled()
  })
})

describe('board actions on a campaign the server drives', () => {
  function serverSetup(tasks: CampaignTask[]) {
    const made = setup(tasks, { driver: 'server' })
    const server = {
      steer: vi.fn(async () => ({})),
      interrupt: vi.fn(async () => ({})),
    }
    const extra = {
      retryTask: vi.fn(async () => ({})),
      acceptAnyway: vi.fn(async () => ({})),
      verifyAgain: vi.fn(async () => ({})),
      resolveTask: vi.fn(async () => ({})),
      skipTask: vi.fn(async () => ({})),
      cancel: vi.fn(async () => ({})),
    }
    Object.assign(made.api, extra)
    made.deps.server = server
    return { ...made, server, extra }
  }

  it('retries through the server driver and does not kick the local runner', async () => {
    const { actions, extra, api, runner } = serverSetup([task('a', 'failed')])
    expect((await actions.retryTask('c1', 'a', 'other way')).ok).toBe(true)
    expect(extra.retryTask).toHaveBeenCalledWith('c1', 'a', 'other way')
    expect(api.transition).not.toHaveBeenCalled()
    expect(runner.kick).not.toHaveBeenCalled()
  })

  it('accepts anyway only with a reason, through the driver', async () => {
    const { actions, extra, api } = serverSetup([
      task('a', 'completed', { verdict: 'BLOCKED' }),
    ])
    expect((await actions.acceptAnyway('c1', 'a', 'me', '  ')).ok).toBe(false)
    expect(extra.acceptAnyway).not.toHaveBeenCalled()
    expect((await actions.acceptAnyway('c1', 'a', 'me', ' read it ')).ok).toBe(true)
    expect(extra.acceptAnyway).toHaveBeenCalledWith('c1', 'a', 'me', 'read it')
    expect(api.transition).not.toHaveBeenCalled()
  })

  it('verifies again, resolves and skips through the driver', async () => {
    const { actions, extra, runner } = serverSetup([
      task('a', 'completed', { verdict: 'BLOCKED' }),
      task('b', 'conflict'),
      task('c', 'failed'),
    ])
    expect((await actions.verifyAgain('c1', 'a')).ok).toBe(true)
    expect(extra.verifyAgain).toHaveBeenCalledWith('c1', 'a')
    expect(runner.verifyTask).not.toHaveBeenCalled()
    expect((await actions.resolveConflict('c1', 'b')).ok).toBe(true)
    expect(extra.resolveTask).toHaveBeenCalledWith('c1', 'b')
    expect((await actions.skipTask('c1', 'c')).ok).toBe(true)
    expect(extra.skipTask).toHaveBeenCalledWith('c1', 'c', 'leave')
  })

  it('steers and stops a live run through the server session, not the local mailbox', async () => {
    const { actions, server, deps, api } = serverSetup([task('a', 'running')])
    expect((await actions.sendNote('c1', 'a', 'mind the tests')).ok).toBe(true)
    expect(server.steer).toHaveBeenCalledWith('s-a', 'mind the tests')
    expect(deps.sendMessage).not.toHaveBeenCalled()
    await actions.stopTask('c1', 'a')
    expect(server.interrupt).toHaveBeenCalledWith('s-a')
    expect(deps.abortRun).not.toHaveBeenCalled()
    expect(api.transition).not.toHaveBeenCalled()
  })

  it('cancels through the server driver', async () => {
    const { actions, extra, runner } = serverSetup([task('a', 'running')])
    await actions.cancel('c1')
    expect(extra.cancel).toHaveBeenCalledWith('c1')
    expect(runner.cancel).not.toHaveBeenCalled()
  })
})
