import { describe, it, expect } from 'vitest'
import type {
  Campaign,
  CampaignTask,
  CampaignTaskStatus,
} from '../campaignModel'
import {
  budgetOf,
  canCancel,
  changedFilesOf,
  claimedSessionIds,
  deriveCampaignGroups,
  dotOf,
  groupOf,
  groupTasks,
  headlineOf,
  primaryActionOf,
  taskActionsOf,
  wordOf,
  TASK_GROUPS,
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

describe('status to dot and group', () => {
  const cases: [CampaignTaskStatus, string, string][] = [
    ['queued', 'queued', 'up-next'],
    ['interrupted', 'queued', 'up-next'],
    ['blocked', 'blocked', 'up-next'],
    ['running', 'running', 'working'],
    ['awaiting_input', 'needs-you', 'needs-you'],
    ['awaiting_approval', 'needs-you', 'needs-you'],
    ['completed', 'verifying', 'working'],
    ['verifying', 'verifying', 'working'],
    ['verified', 'verified', 'working'],
    ['merged', 'merged', 'done'],
    ['failed', 'failed', 'needs-you'],
    ['conflict', 'conflict', 'needs-you'],
    ['cancelled', 'cancelled', 'done'],
  ]
  it.each(cases)('%s is dot %s in group %s', (status, dot, group) => {
    expect(dotOf(task('t', status))).toBe(dot)
    expect(groupOf(task('t', status))).toBe(group)
  })

  it('a pending task waits until its dependencies are merged', () => {
    const a = task('a', 'running')
    const b = task('b', 'pending', { dependsOn: ['a'] })
    expect(dotOf(b, [a, b])).toBe('blocked')
    expect(groupOf(b, [a, b])).toBe('up-next')
    expect(wordOf(b, [a, b])).toEqual({ word: 'waiting', waitingFor: ['a'] })
    const merged = task('a', 'merged')
    expect(wordOf(b, [merged, b])).toEqual({ word: 'queued', waitingFor: [] })
    expect(dotOf(task('c', 'pending'), [])).toBe('queued')
  })

  it('groupTasks keeps only groups that hold something, in a fixed order', () => {
    const g = groupTasks([
      task('a', 'merged'),
      task('b', 'running'),
      task('c', 'merged'),
      task('d', 'failed'),
    ])
    expect(g.map((x) => x.group)).toEqual(['needs-you', 'working', 'done'])
    expect(g.find((x) => x.group === 'done')!.tasks.map((t) => t.id)).toEqual([
      'a',
      'c',
    ])
    expect(groupTasks([])).toEqual([])
    expect(TASK_GROUPS).toEqual(['needs-you', 'working', 'up-next', 'done'])
  })

  it('names each state in a plain word', () => {
    const w = (s: CampaignTaskStatus) => wordOf(task('t', s)).word
    expect(w('running')).toBe('writing')
    expect(w('verifying')).toBe('checking')
    expect(w('merged')).toBe('merged')
    expect(w('failed')).toBe('failed')
    expect(w('awaiting_approval')).toBe('needsApproval')
    expect(w('cancelled')).toBe('skipped')
  })
})

describe('headline and primary action', () => {
  const c = (status: Campaign['status'], tasks: CampaignTask[]) =>
    campaign(tasks, { status })

  it('says where the campaign stands in one plain key', () => {
    expect(headlineOf(c('running', [])).key).toBe('planning')
    expect(
      headlineOf(c('running', [task('a', 'merged'), task('b', 'running')]))
    ).toMatchObject({ key: 'working', done: 1, total: 2 })
    expect(
      headlineOf(c('running', [task('a', 'failed'), task('b', 'running')]))
    ).toMatchObject({ key: 'attention', count: 1 })
    expect(headlineOf(c('reviewing', [task('a', 'merged')])).key).toBe('review')
    expect(headlineOf(c('merging', [task('a', 'merged')])).key).toBe('merging')
    expect(headlineOf(c('paused', [task('a', 'queued')])).key).toBe('paused')
    expect(headlineOf(c('done', [task('a', 'merged')])).key).toBe('done')
    expect(headlineOf(c('failed', [task('a', 'failed')])).key).toBe('failed')
    expect(headlineOf(c('cancelled', [])).key).toBe('cancelled')
    expect(headlineOf(c('interrupted', [task('a', 'queued')])).key).toBe(
      'interrupted'
    )
  })

  it('leads with the one button that fits', () => {
    expect(primaryActionOf(c('running', [task('a', 'running')]))).toBe('pause')
    expect(primaryActionOf(c('running', [task('a', 'awaiting_input')]))).toBe(
      'coordinator'
    )
    expect(primaryActionOf(c('paused', []))).toBe('resume')
    expect(primaryActionOf(c('interrupted', []))).toBe('resume')
    expect(primaryActionOf(c('reviewing', []))).toBe('review')
    expect(primaryActionOf(c('done', []))).toBe('coordinator')
  })

  it('allows cancelling only an unfinished campaign', () => {
    expect(canCancel('running')).toBe(true)
    expect(canCancel('paused')).toBe(true)
    expect(canCancel('done')).toBe(false)
    expect(canCancel('cancelled')).toBe(false)
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

  it('marks a finished campaign so the sidebar can fold it to one line', () => {
    const live = deriveCampaignGroups([c], [{ id: 's-b' }])[0]
    expect(live.finished).toBe(false)
    const over = campaign([task('x', 'merged', { sessionId: 's-x' })], {
      id: 'over',
      status: 'done',
      coordinatorSession: 'c-over',
    })
    const [g] = deriveCampaignGroups([over], [{ id: 'c-over' }, { id: 's-x' }])
    expect(g.finished).toBe(true)
  })

  it('keeps a campaign\'s sessions only in its group, even a retried task\'s old one', () => {
    const retried = campaign(
      [task('a', 'running', { sessionId: 's-new' })],
      { id: 'r1', coordinatorSession: 'c-r' }
    )
    const sessions = [
      { id: 'c-r' },
      { id: 's-new', campaign: { id: 'r1', taskId: 'a', role: 'task' as const } },
      { id: 's-old', campaign: { id: 'r1', taskId: 'a', role: 'task' as const } },
      { id: 'plain' },
    ]
    const [g] = deriveCampaignGroups([retried], sessions)
    expect(g.rows.map((r) => r.sessionId)).toEqual(['c-r', 's-new', 's-old'])
    const claimed = claimedSessionIds([g])
    expect(claimed.has('plain')).toBe(false)
    expect(claimed.has('s-old')).toBe(true)
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
