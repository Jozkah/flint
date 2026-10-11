import { describe, it, expect } from 'vitest'
import type {
  Campaign,
  CampaignTask,
  CampaignTaskStatus,
} from '../campaignModel'
import {
  BOARD_COLUMNS,
  budgetOf,
  changedFilesOf,
  claimedSessionIds,
  columnOf,
  deriveCampaignGroups,
  dotOf,
  groupByColumn,
  taskActionsOf,
} from '../campaignView'
import { pollDelay, POLL_ACTIVE_MS, POLL_IDLE_MS } from '@/hooks/useCampaigns'

const task = (
  id: string,
  status: CampaignTaskStatus = 'pending',
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
  ...over,
})

const campaign = (
  tasks: CampaignTask[],
  over: Partial<Campaign> = {}
): Campaign => ({
  schemaVersion: 1,
  id: 'c1',
  title: 'Campaign',
  coordinatorSession: 'coord',
  sourceRoot: '/repo',
  baseBranch: 'main',
  baseSha: 'abc',
  integrationBranch: 'flint/campaign-c1',
  integrationWorktree: '/w',
  modeCeiling: 'auto',
  model: '',
  limits: { maxParallel: 4, maxTasks: 12 },
  status: 'running',
  processEpoch: 'e',
  createdAt: '',
  updatedAt: '',
  tasks,
  ...over,
})

describe('status to dot and column', () => {
  const cases: [CampaignTaskStatus, string, string][] = [
    ['queued', 'queued', 'queued'],
    ['interrupted', 'queued', 'queued'],
    ['blocked', 'blocked', 'blocked'],
    ['running', 'running', 'running'],
    ['awaiting_input', 'needs-you', 'needs-you'],
    ['awaiting_approval', 'needs-you', 'needs-you'],
    ['completed', 'verifying', 'verifying'],
    ['verifying', 'verifying', 'verifying'],
    ['verified', 'verified', 'done'],
    ['merged', 'merged', 'done'],
    ['failed', 'failed', 'failed'],
    ['conflict', 'conflict', 'failed'],
    ['cancelled', 'cancelled', 'failed'],
  ]
  it.each(cases)('%s is dot %s in column %s', (status, dot, col) => {
    expect(dotOf(task('t', status))).toBe(dot)
    expect(columnOf(task('t', status))).toBe(col)
  })

  it('a pending task waits as blocked until its dependencies are merged', () => {
    const a = task('a', 'running')
    const b = task('b', 'pending', { dependsOn: ['a'] })
    expect(columnOf(b, [a, b])).toBe('blocked')
    const merged = task('a', 'merged')
    expect(columnOf(b, [merged, b])).toBe('queued')
    expect(dotOf(task('c', 'pending'), [])).toBe('queued')
  })

  it('groupByColumn fills every column and keeps plan order', () => {
    const g = groupByColumn([
      task('a', 'merged'),
      task('b', 'running'),
      task('c', 'merged'),
    ])
    expect(Object.keys(g)).toEqual([...BOARD_COLUMNS])
    expect(g.done.map((t) => t.id)).toEqual(['a', 'c'])
    expect(g.blocked).toEqual([])
  })
})

describe('deriveCampaignGroups', () => {
  const c = campaign(
    [
      task('a', 'merged', { sessionId: 's-a' }),
      task('b', 'running', { sessionId: 's-b' }),
      task('c', 'pending', { sessionId: null, dependsOn: ['b'] }),
    ],
    { title: 'Ship it' }
  )

  it('lists the coordinator then the task sessions with dots and a count', () => {
    const [g] = deriveCampaignGroups(
      [c],
      [{ id: 'coord' }, { id: 's-a' }, { id: 's-b' }, { id: 'other' }]
    )
    expect(g.rows.map((r) => [r.sessionId, r.role, r.dot])).toEqual([
      ['coord', 'coordinator', undefined],
      ['s-a', 'task', 'merged'],
      ['s-b', 'task', 'running'],
    ])
    expect(g.done).toBe(1)
    expect(g.total).toBe(3)
    expect([...claimedSessionIds([g])].sort()).toEqual(['coord', 's-a', 's-b'])
  })

  it('leaves out sessions that no longer exist and empty groups', () => {
    expect(deriveCampaignGroups([c], [{ id: 'other' }])).toEqual([])
    const [g] = deriveCampaignGroups([c], [{ id: 's-b' }])
    expect(g.rows.map((r) => r.sessionId)).toEqual(['s-b'])
  })

  it('shows no group for a plan that never started (denied, cancelled or waiting)', () => {
    for (const status of ['planned', 'cancelled', 'draft'] as const) {
      const never = campaign([task('a', 'pending', { sessionId: null })], {
        status,
      })
      expect(deriveCampaignGroups([never], [{ id: 'coord' }])).toEqual([])
    }
    // Once a task has a session the campaign is real, whatever its status.
    const started = campaign([task('a', 'cancelled', { sessionId: 's-a' })], {
      status: 'cancelled',
    })
    expect(deriveCampaignGroups([started], [{ id: 's-a' }])).toHaveLength(1)
  })

  it('never shows a session twice and puts active campaigns first', () => {
    const old = campaign([task('x', 'merged', { sessionId: 's-x' })], {
      id: 'old',
      status: 'done',
      coordinatorSession: 'c-old',
    })
    const twin = campaign([task('y', 'running', { sessionId: 's-b' })], {
      id: 'twin',
      coordinatorSession: 'c-twin',
    })
    const groups = deriveCampaignGroups(
      [old, c, twin],
      ['c-old', 's-x', 'coord', 's-b', 'c-twin'].map((id) => ({ id }))
    )
    expect(groups.map((g) => g.campaignId)).toEqual(['c1', 'twin', 'old'])
    const twinRows = groups.find((g) => g.campaignId === 'twin')!.rows
    expect(twinRows.map((r) => r.sessionId)).toEqual(['c-twin'])
  })

  it('is pure over its inputs', () => {
    const before = JSON.stringify(c)
    deriveCampaignGroups([c], [{ id: 'coord' }])
    expect(JSON.stringify(c)).toBe(before)
  })
})

describe('budgetOf', () => {
  const withBudget = (used: number[], budget: number | null) =>
    budgetOf({
      tasks: used.map((n, i) => task(`t${i}`, 'running', { tokensUsed: n })),
      limits: { maxParallel: 4, maxTasks: 12, tokenBudget: budget },
    })

  it('sums tokens and reports percent and level', () => {
    expect(withBudget([100, 300], 1000)).toEqual({
      used: 400,
      budget: 1000,
      percent: 40,
      level: 'ok',
    })
    expect(withBudget([800], 1000).level).toBe('warn')
    expect(withBudget([1500], 1000)).toMatchObject({
      percent: 100,
      level: 'over',
    })
  })

  it('has no bar without a budget', () => {
    expect(withBudget([5], null)).toEqual({
      used: 5,
      budget: null,
      percent: 0,
      level: 'none',
    })
    expect(withBudget([5], 0).level).toBe('none')
  })
})

describe('taskActionsOf and changedFilesOf', () => {
  it('offers only what the state allows', () => {
    const run = taskActionsOf({ status: 'running', sessionId: 's', attempt: 0 })
    expect(run).toMatchObject({ open: true, note: true, stop: true, retry: false })
    const failed = taskActionsOf({ status: 'failed', sessionId: 's', attempt: 0 })
    expect(failed).toMatchObject({
      retry: true,
      skip: true,
      stop: false,
      note: false,
    })
    expect(
      taskActionsOf({ status: 'failed', sessionId: 's', attempt: 2 }).retry
    ).toBe(false)
    const queued = taskActionsOf({
      status: 'queued',
      sessionId: null,
      attempt: 0,
    })
    expect(queued).toMatchObject({ open: false, stop: true, handoff: false })
    expect(
      taskActionsOf({ status: 'merged', sessionId: 's', attempt: 0 }).stop
    ).toBe(false)
  })

  it('counts distinct changed files only', () => {
    expect(
      changedFilesOf([
        { path: 'b.ts', ok: true, operation: 'edit' },
        { path: 'a.ts', ok: true, operation: 'write' },
        { path: 'a.ts', ok: true, operation: 'edit' },
        { path: 'c.ts', ok: true, operation: 'read' },
        { path: 'd.ts', ok: false, operation: 'write' },
      ])
    ).toEqual(['a.ts', 'b.ts'])
    expect(changedFilesOf(undefined)).toEqual([])
  })
})

describe('pollDelay', () => {
  it('polls fast while something moves and slowly otherwise', () => {
    expect(pollDelay([campaign([], { status: 'running' })])).toBe(
      POLL_ACTIVE_MS
    )
    expect(pollDelay([campaign([], { status: 'done' })])).toBe(POLL_IDLE_MS)
    expect(pollDelay([])).toBe(POLL_IDLE_MS)
  })
})
