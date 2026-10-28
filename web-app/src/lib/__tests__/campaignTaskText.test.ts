import { describe, expect, it } from 'vitest'
import {
  groupTextOf,
  headlineTextOf,
  stopClause,
  wordTextOf,
  type HeadlineParams,
} from '../campaignTaskText'
import type { StepGroup } from '../campaignStory'

// Echoes the key and options so each branch is visible in the assertion.
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}${JSON.stringify(options)}` : key

const params = (over: Partial<HeadlineParams> = {}): HeadlineParams => ({
  count: 2,
  added: 5,
  removed: 1,
  failures: 0,
  steps: 3,
  tasks: 'A, B',
  counted: true,
  ...over,
})

describe('campaignTaskText', () => {
  it('names what a waiting task waits on', () => {
    expect(wordTextOf(t, 'waiting', ['A', 'B'])).toBe(
      'settings:campaigns.board.word.waiting{"tasks":"A, B"}'
    )
    expect(wordTextOf(t, 'done', [])).toBe('settings:campaigns.board.word.done')
  })

  it('chooses the stop clause by failure count', () => {
    expect(stopClause(t, 0)).toContain('stop.none')
    expect(stopClause(t, 1)).toContain('stop.one')
    expect(stopClause(t, 4)).toContain('stop.many{"count":4}')
  })

  it('builds each headline kind', () => {
    expect(headlineTextOf(t, 'wrote', params())).toContain('story.wrote{')
    expect(headlineTextOf(t, 'wrote', params({ counted: false }))).toContain('wroteUncounted')
    const stopped = headlineTextOf(t, 'wroteStopped', params({ failures: 1 }))
    expect(stopped).toContain('. settings:campaigns.board.story.stop.one')
    expect(headlineTextOf(t, 'working', params())).toContain('headline.working{"count":3}')
    expect(headlineTextOf(t, 'waiting', params())).toContain('"tasks":"A, B"')
    expect(headlineTextOf(t, 'skipped', params())).toBe('settings:campaigns.board.story.headline.skipped')
  })

  it('summarises a group of steps', () => {
    const steps = ['a', 'b', 'c', 'd'].map((label) => ({ label })) as unknown as StepGroup['steps']
    const many = groupTextOf(t, { kind: 'read', ok: true, steps } as StepGroup)
    expect(many.sub).toBe('a, b, c, +1')
    expect(many.main).toContain('readMany{"count":4}')
    const one = groupTextOf(t, { kind: 'command', ok: false, steps: steps.slice(0, 1) } as StepGroup)
    expect(one.main).toContain('ranFailed')
    expect(one.sub).toBeUndefined()
  })
})
