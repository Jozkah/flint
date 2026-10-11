import { describe, expect, it } from 'vitest'
import { stalledTaskIds } from '../useStalledTasks'

const task = (id: string, status: string, sessionId: string | null = `s-${id}`) => ({
  id,
  status,
  sessionId,
})

describe('stalledTaskIds', () => {
  it('flags a running task with no live run only after the grace period', () => {
    const seen = new Map<string, number>()
    const tasks = [task('a', 'running')]
    expect(stalledTaskIds(tasks, new Set(), seen, 1_000)).toEqual([])
    expect(stalledTaskIds(tasks, new Set(), seen, 10_500)).toEqual([])
    expect(stalledTaskIds(tasks, new Set(), seen, 11_500)).toEqual(['a'])
  })

  it('ignores tasks that have a live run, are not running or have no session', () => {
    const seen = new Map<string, number>()
    const tasks = [
      task('a', 'running'),
      task('b', 'queued'),
      task('c', 'running', null),
      task('d', 'awaiting_input'),
    ]
    stalledTaskIds(tasks, new Set(['s-a']), seen, 0)
    expect(stalledTaskIds(tasks, new Set(['s-a']), seen, 60_000)).toEqual([])
  })

  it('restarts the clock when the run comes back and goes again', () => {
    const seen = new Map<string, number>()
    const tasks = [task('a', 'running')]
    stalledTaskIds(tasks, new Set(), seen, 0)
    expect(stalledTaskIds(tasks, new Set(['s-a']), seen, 20_000)).toEqual([])
    expect(stalledTaskIds(tasks, new Set(), seen, 25_000)).toEqual([])
    expect(stalledTaskIds(tasks, new Set(), seen, 36_000)).toEqual(['a'])
  })
})
