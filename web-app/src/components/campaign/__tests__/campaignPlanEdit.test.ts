import { describe, expect, it } from 'vitest'
import {
  addTask,
  moveTask,
  planChanged,
  readEstimate,
  removeTask,
  validatePlan,
} from '@/lib/campaignPlanEdit'
import type { PlanTask } from '@/lib/campaignModel'

const task = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: id,
  brief: `do ${id}`,
  acceptance: [],
  paths: [],
  dependsOn: [],
  ...extra,
})

describe('validatePlan', () => {
  it('accepts a sound plan', () => {
    expect(validatePlan([task('a'), task('b', { dependsOn: ['a'] })])).toEqual([])
  })
  it('names empty brief, cycle, overlap and too many tasks', () => {
    expect(validatePlan([task('a', { brief: ' ' })])[0].code).toBe('emptyBrief')
    const cyc = validatePlan([
      task('a', { dependsOn: ['b'] }),
      task('b', { dependsOn: ['a'] }),
    ])
    expect(cyc.map((i) => i.code)).toContain('cycle')
    const over = validatePlan([
      task('a', { paths: ['src'] }),
      task('b', { paths: ['src/x.ts'] }),
    ])
    expect(over[0]).toMatchObject({ code: 'overlap', path: 'src' })
    // Ordered tasks may share a path.
    expect(
      validatePlan([
        task('a', { paths: ['src'] }),
        task('b', { paths: ['src'], dependsOn: ['a'] }),
      ])
    ).toEqual([])
    const many = Array.from({ length: 13 }, (_, i) => task(`t${i}`))
    expect(validatePlan(many).map((i) => i.code)).toContain('tooMany')
    expect(validatePlan([])[0].code).toBe('noTasks')
  })
  it('rejects absolute and parent paths', () => {
    expect(validatePlan([task('a', { paths: ['../x'] })])[0].code).toBe('badPath')
  })
})

describe('edits', () => {
  it('removing a task drops dependencies on it', () => {
    const out = removeTask([task('a'), task('b', { dependsOn: ['a'] })], 'a')
    expect(out).toHaveLength(1)
    expect(out[0].dependsOn).toEqual([])
  })
  it('adds with a fresh id and reorders', () => {
    const added = addTask([task('t2')])
    expect(added.map((t) => t.id)).toEqual(['t2', 't3'])
    expect(moveTask(added, 't3', -1).map((t) => t.id)).toEqual(['t3', 't2'])
    expect(planChanged(added, moveTask(added, 't3', -1))).toBe(true)
    expect(planChanged(added, [...added])).toBe(false)
  })
})

describe('readEstimate', () => {
  it('reads the backend shape and hides the unknown', () => {
    expect(
      readEstimate({ low: 1000, expected: 2000, high: 3000, basis: 'history', samples: 4 })
    ).toMatchObject({ low: 1000, high: 3000 })
    expect(readEstimate(undefined)).toBeNull()
    expect(readEstimate('x')).toBeNull()
  })
})
