import { describe, expect, it, vi } from 'vitest'
import {
  buildCoordinatorOpening,
  CAMPAIGN_GOAL_MAX,
  cleanGoal,
  startCampaign,
  titleFromGoal,
  type StartDeps,
} from '../campaignStart'

const deps = (): StartDeps & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    createSession: vi.fn(() => {
      calls.push('create')
      return 's1'
    }),
    setFolder: vi.fn((id, folder) => void calls.push(`folder ${id} ${folder}`)),
    setTitle: vi.fn((id, title) => void calls.push(`title ${id} ${title}`)),
    enqueue: vi.fn((id) => void calls.push(`enqueue ${id}`)),
    select: vi.fn((id) => void calls.push(`select ${id}`)),
  }
}

describe('starting a campaign', () => {
  it('asks the model to plan with campaign_plan and carries the goal', () => {
    const text = buildCoordinatorOpening('  add dark mode  ')
    expect(text).toContain('campaign_plan')
    expect(text).toContain('Goal: add dark mode')
  })

  it('caps the goal and cuts the title at a word', () => {
    expect(cleanGoal('x'.repeat(CAMPAIGN_GOAL_MAX + 50))).toHaveLength(
      CAMPAIGN_GOAL_MAX
    )
    const title = titleFromGoal(
      'add dark mode across every settings page and every dialog in the app\nmore'
    )
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(61)
    expect(title).not.toContain('\n')
    expect(titleFromGoal('short goal')).toBe('short goal')
  })

  it('creates the session on the folder, queues the opening and shows it', () => {
    const d = deps()
    const out = startCampaign({ goal: 'ship it', folder: '/repo' }, d)
    expect(out).toEqual({ ok: true, sessionId: 's1' })
    expect(d.calls).toEqual([
      'create',
      'folder s1 /repo',
      'title s1 ship it',
      'enqueue s1',
      'select s1',
    ])
    expect(vi.mocked(d.enqueue).mock.calls[0][1]).toContain('campaign_plan')
  })

  it('does nothing without a goal or a folder', () => {
    const d = deps()
    expect(startCampaign({ goal: '   ', folder: '/repo' }, d)).toEqual({
      ok: false,
      reason: 'empty-goal',
    })
    expect(startCampaign({ goal: 'x', folder: null }, d)).toEqual({
      ok: false,
      reason: 'no-folder',
    })
    expect(d.createSession).not.toHaveBeenCalled()
  })
})
