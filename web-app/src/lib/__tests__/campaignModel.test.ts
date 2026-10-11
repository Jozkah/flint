import { describe, it, expect } from 'vitest'
import {
  CAMPAIGN_DEFAULT_MAX_PARALLEL,
  CAMPAIGN_MAX_PARALLEL_CAP,
  campaignCeiling,
  clampCampaignParallel,
  nextActions,
  taskModeFor,
  type Campaign,
  type CampaignTask,
  type CampaignTaskStatus,
} from '../campaignModel'

const task = (
  id: string,
  status: CampaignTaskStatus = 'pending',
  dependsOn: string[] = [],
  over: Partial<CampaignTask> = {}
): CampaignTask => ({
  id,
  title: id,
  brief: `do ${id}`,
  acceptance: [],
  paths: [],
  dependsOn,
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
  title: 'C',
  coordinatorSession: 'coord',
  sourceRoot: '/repo',
  baseBranch: 'main',
  baseSha: 'abc',
  integrationBranch: 'flint/campaign-c1',
  integrationWorktree: '/w/c1',
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

const starts = (c: Campaign, max: number, free?: number, live: string[] = []) =>
  nextActions(c, { liveTasks: live, freePanes: free }, max)
    .filter((a) => a.action === 'start')
    .map((a) => a.taskId)

describe('clampCampaignParallel', () => {
  it('forces the setting into 1..6 and defaults to 4', () => {
    expect(clampCampaignParallel(0)).toBe(1)
    expect(clampCampaignParallel(-5)).toBe(1)
    expect(clampCampaignParallel(99)).toBe(CAMPAIGN_MAX_PARALLEL_CAP)
    expect(clampCampaignParallel(3.4)).toBe(3)
    expect(clampCampaignParallel(undefined)).toBe(CAMPAIGN_DEFAULT_MAX_PARALLEL)
    expect(clampCampaignParallel('x')).toBe(CAMPAIGN_DEFAULT_MAX_PARALLEL)
    expect(CAMPAIGN_DEFAULT_MAX_PARALLEL).toBe(4)
    expect(CAMPAIGN_MAX_PARALLEL_CAP).toBe(6)
  })
})

describe('nextActions', () => {
  it('starts independent tasks and holds dependents until their dependency is merged', () => {
    const c = campaign([task('a'), task('b', 'pending', ['a']), task('c')])
    expect(starts(c, 4)).toEqual(['a', 'c'])
    // A finished but unmerged dependency does not release its dependent.
    const done = campaign([
      task('a', 'completed'),
      task('b', 'pending', ['a']),
    ])
    expect(starts(done, 4)).toEqual([])
    const verified = campaign([
      task('a', 'verified'),
      task('b', 'pending', ['a']),
    ])
    expect(starts(verified, 4)).toEqual([])
    const merged = campaign([task('a', 'merged'), task('b', 'pending', ['a'])])
    expect(starts(merged, 4)).toEqual(['b'])
  })

  it('caps the number of running tasks at the setting', () => {
    const c = campaign(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => task(id)))
    expect(starts(c, 2)).toEqual(['a', 'b'])
    expect(starts(c, 6)).toHaveLength(6)
    // Out-of-range settings are clamped, not trusted.
    expect(starts(c, 99)).toHaveLength(6)
    expect(starts(c, 0)).toHaveLength(1)
  })

  it('counts running tasks against the cap, once', () => {
    const c = campaign([
      task('a', 'running', [], { sessionId: 's-a' }),
      task('b'),
      task('c'),
    ])
    expect(starts(c, 2)).toEqual(['b'])
    // The record and the live runs both name `a`: still one slot.
    expect(starts(c, 2, undefined, ['a'])).toEqual(['b'])
  })

  it('applies a raised setting to a running campaign at once', () => {
    const c = campaign([
      task('a', 'running'),
      task('b', 'running'),
      task('c'),
      task('d'),
    ])
    expect(starts(c, 2)).toEqual([])
    expect(starts(c, 4)).toEqual(['c', 'd'])
  })

  it('is limited by free panes on top of the setting', () => {
    const c = campaign([task('a'), task('b'), task('c')])
    expect(starts(c, 4, 1)).toEqual(['a'])
    expect(starts(c, 4, 0)).toEqual([])
  })

  it('only schedules a running campaign', () => {
    for (const status of ['planned', 'approved', 'paused', 'cancelled'] as const) {
      expect(starts(campaign([task('a')], { status }), 4)).toEqual([])
    }
  })

  it('stops starting once the token budget is spent', () => {
    const spent = campaign(
      [task('a', 'completed', [], { tokensUsed: 100 }), task('b')],
      { limits: { maxParallel: 4, maxTasks: 12, tokenBudget: 100 } }
    )
    expect(starts(spent, 4)).toEqual([])
  })

  it('blocks a task whose dependency was cancelled', () => {
    const c = campaign([task('a', 'cancelled'), task('b', 'pending', ['a'])])
    const actions = nextActions(c, { liveTasks: [] }, 4)
    expect(actions).toEqual([
      { action: 'block', taskId: 'b', because: 'dependency a was cancelled' },
    ])
  })

  it('re-queues an interrupted task only after it is queued again', () => {
    const c = campaign([task('a', 'interrupted'), task('b', 'queued')])
    expect(starts(c, 4)).toEqual(['b'])
  })
})

describe('task modes', () => {
  it('never lets bypass through, and never exceeds the ceiling', () => {
    expect(campaignCeiling('bypass')).toBe('auto')
    expect(taskModeFor('bypass')).not.toBe('bypass')
    expect(taskModeFor('auto')).toBe('auto')
    expect(taskModeFor('ask')).toBe('ask')
    expect(taskModeFor('review')).toBe('review')
    // An unrecognised ceiling falls to the cautious end.
    expect(taskModeFor('whatever')).toBe('ask')
  })
})
