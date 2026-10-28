import { describe, it, expect, vi } from 'vitest'
import { createNotifier } from '../notifications'
import { createSweeper } from '../limits'
import type { Campaign } from '@/lib/campaignModel'

const campaign = (over: Partial<Campaign> = {}): Campaign =>
  ({
    id: 'c1',
    title: 'T',
    status: 'done',
    tasks: [],
    limits: {},
    ...over,
  }) as unknown as Campaign

describe('createNotifier', () => {
  it('claims a notice once per process and notifies only the first claimant', async () => {
    const desktopNotify = vi.fn(() => true)
    const claimNotice = vi.fn(async () => true)
    const { announce } = createNotifier({ host: { desktopNotify }, api: { claimNotice } })
    expect(await announce(campaign())).toBe(true)
    expect(await announce(campaign())).toBe(false)
    expect(claimNotice).toHaveBeenCalledTimes(1)
    expect(desktopNotify).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when another window already claimed it', async () => {
    const desktopNotify = vi.fn(() => true)
    const { announce } = createNotifier({
      host: { desktopNotify },
      api: { claimNotice: async () => false },
    })
    expect(await announce(campaign())).toBe(false)
    expect(desktopNotify).not.toHaveBeenCalled()
  })
})

describe('createSweeper', () => {
  const build = (c: Campaign, hostOver: Record<string, unknown> = {}) => {
    const abortRun = vi.fn()
    const limitReasons = new Map<string, string>()
    const api = { get: vi.fn(async () => c), transition: vi.fn(async () => c) }
    const { sweep } = createSweeper({
      host: {
        liveSessions: () => new Set(['s1']),
        abortRun,
        runInfo: () => ({ startedAt: 0, steps: 5, tokens: 0 }),
        ...hostOver,
      } as never,
      api: api as never,
      now: () => 10_000,
      serialize: (_id, work) => work(),
      tick: async () => ({ started: [], blocked: [] }),
      announce: async () => false,
      limitReasons,
      startedAt: new Map(),
    })
    return { sweep, abortRun, limitReasons, api }
  }

  it('aborts a run that went over its step limit and records why', async () => {
    const c = campaign({
      status: 'running',
      limits: { taskSteps: 5 } as never,
      tasks: [{ id: 't1', status: 'running', sessionId: 's1' }] as never,
    })
    const { sweep, abortRun, limitReasons } = build(c)
    await sweep('c1')
    expect(abortRun).toHaveBeenCalledWith('s1')
    expect(limitReasons.get('s1')).toMatch(/step limit of 5/)
  })

  it('re-queues a task whose pane closed before its run began', async () => {
    const c = campaign({
      status: 'running',
      tasks: [{ id: 't1', status: 'running', sessionId: 's2' }] as never,
    })
    const { sweep, api } = build(c, { isShown: () => false, hasEnded: () => false })
    await sweep('c1')
    const moves = api.transition.mock.calls.map(
      (call) => (call[1] as { task: { to: string } }).task.to
    )
    expect(moves).toEqual(['interrupted', 'queued'])
  })
})
