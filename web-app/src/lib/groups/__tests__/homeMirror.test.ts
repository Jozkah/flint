import { describe, expect, it } from 'vitest'
import { planThreadMirror, projectsFromGroups } from '../homeMirror'
import { createGroup, emptyGroupsState, moveItem, renameGroup } from '../domain'

const threads = [
  { id: 't1', metadata: { project: { id: 'p1', name: 'Old', updated_at: 0 } } },
  { id: 't2', metadata: {} },
  { id: 't3', metadata: { project: { id: 'gone', name: 'Gone', updated_at: 0 } } },
] as unknown as Thread[]

describe('home legacy mirror', () => {
  it('writes metadata.project only where it disagrees with the group', () => {
    let s = createGroup(emptyGroupsState(), 'home', { id: 'p1', name: 'Old', now: 0 })
    s = moveItem(s, 'home', 't1', 'p1')
    s = moveItem(s, 'home', 't2', 'p1')
    s = renameGroup(s, 'home', 'p1', 'New', 5)
    const plan = planThreadMirror(s.surfaces.home, threads)
    expect(plan).toEqual([
      { id: 't1', project: { id: 'p1', name: 'New', updated_at: 5 } },
      { id: 't2', project: { id: 'p1', name: 'New', updated_at: 5 } },
      { id: 't3', project: undefined },
    ])
  })

  it('is a no-op when everything agrees', () => {
    let s = createGroup(emptyGroupsState(), 'home', { id: 'p1', name: 'Old', now: 0 })
    s = moveItem(s, 'home', 't1', 'p1')
    expect(planThreadMirror(s.surfaces.home, [threads[0], threads[1]])).toEqual([])
  })

  it('keeps project assistants and group order', () => {
    let s = createGroup(emptyGroupsState(), 'home', { id: 'a', name: 'A', now: 1 })
    s = createGroup(s, 'home', { id: 'b', name: 'B', now: 2 })
    expect(projectsFromGroups(s.surfaces.home.groups, [{ id: 'b', name: 'B', updated_at: 0, assistantId: 'x' }])).toEqual([
      { id: 'a', name: 'A', updated_at: 1 },
      { id: 'b', name: 'B', updated_at: 2, assistantId: 'x' },
    ])
  })
})
