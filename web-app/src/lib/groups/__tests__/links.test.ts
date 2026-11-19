import { describe, expect, it } from 'vitest'
import {
  createGroup,
  deleteGroup,
  emptyGroupsState,
  moveItem,
  sanitizeGroupsState,
  setGroupLink,
} from '../domain'
import {
  coworkGroupsLinkedTo,
  itemIdsInGroupTree,
  linkedHomeGroup,
  linkedHomeGroupOfSession,
} from '../links'
import { linkedHomeGroups } from '../../linkedChatArtifacts'
import type { GroupsState } from '../types'

const base = (): GroupsState => {
  let s = emptyGroupsState()
  s = createGroup(s, 'home', { id: 'h1', name: 'Chat A', now: 1 })
  s = createGroup(s, 'cowork', { id: 'c1', name: 'Work A', now: 1 })
  s = createGroup(s, 'cowork', { id: 'c2', name: 'Sub', now: 1, parentId: 'c1' })
  return s
}

describe('setGroupLink', () => {
  it('links a cowork group to an existing home group and unlinks', () => {
    let s = setGroupLink(base(), 'cowork', 'c1', 'h1', 5)
    expect(s.surfaces.cowork.groups.find((g) => g.id === 'c1')?.linkedGroupId).toBe('h1')
    expect(s.surfaces.home.groups[0]).not.toHaveProperty('linkedGroupId')
    s = setGroupLink(s, 'cowork', 'c1', null, 6)
    expect(s.surfaces.cowork.groups.find((g) => g.id === 'c1')).not.toHaveProperty('linkedGroupId')
  })

  it('refuses a missing home group, a missing cowork group, and any other surface', () => {
    expect(() => setGroupLink(base(), 'cowork', 'c1', 'nope', 1)).toThrow()
    expect(() => setGroupLink(base(), 'cowork', 'nope', 'h1', 1)).toThrow()
    expect(() => setGroupLink(base(), 'home', 'h1', 'h1', 1)).toThrow()
  })

  it('is a no-op when nothing changes', () => {
    const s = setGroupLink(base(), 'cowork', 'c1', 'h1', 5)
    expect(setGroupLink(s, 'cowork', 'c1', 'h1', 9)).toBe(s)
  })
})

describe('persistence shape', () => {
  it('reads data written before links existed', () => {
    const old = JSON.parse(JSON.stringify(base()))
    const s = sanitizeGroupsState(old)
    expect(s.surfaces.cowork.groups).toHaveLength(2)
    expect(s.surfaces.cowork.groups[0].linkedGroupId).toBeUndefined()
  })

  it('keeps a link on cowork groups through a round trip, and drops it elsewhere', () => {
    const linked = setGroupLink(base(), 'cowork', 'c1', 'h1', 5)
    const raw = JSON.parse(JSON.stringify(linked))
    raw.surfaces.home.groups[0].linkedGroupId = 'x'
    const s = sanitizeGroupsState(raw)
    expect(s.surfaces.cowork.groups.find((g) => g.id === 'c1')?.linkedGroupId).toBe('h1')
    expect(s.surfaces.home.groups[0].linkedGroupId).toBeUndefined()
  })
})

describe('resolving links', () => {
  const linked = () => {
    let s = setGroupLink(base(), 'cowork', 'c1', 'h1', 5)
    s = moveItem(s, 'cowork', 'sess-1', 'c1')
    s = moveItem(s, 'cowork', 'sess-2', 'c2')
    s = moveItem(s, 'cowork', 'sess-3', null)
    s = moveItem(s, 'home', 'thread-1', 'h1')
    return s
  }

  it('finds the home group of a session, inheriting from a parent group', () => {
    const s = linked()
    expect(linkedHomeGroupOfSession(s, 'sess-1')?.id).toBe('h1')
    expect(linkedHomeGroupOfSession(s, 'sess-2')?.id).toBe('h1')
    expect(linkedHomeGroupOfSession(s, 'sess-3')).toBeUndefined()
    expect(linkedHomeGroupOfSession(s, undefined)).toBeUndefined()
  })

  it('ignores a link whose home group was deleted', () => {
    const s = deleteGroup(linked(), 'home', 'h1')
    expect(linkedHomeGroupOfSession(s, 'sess-1')).toBeUndefined()
    expect(linkedHomeGroup(s, s.surfaces.cowork.groups[0])).toBeUndefined()
    expect(linkedHomeGroups(s).size).toBe(0)
  })

  it('derives the reverse direction from the cowork side', () => {
    const s = linked()
    expect(coworkGroupsLinkedTo(s, 'h1').map((g) => g.id)).toEqual(['c1'])
    expect(coworkGroupsLinkedTo(s, 'other')).toEqual([])
    expect([...linkedHomeGroups(s)]).toEqual([['h1', 'Chat A']])
    expect(itemIdsInGroupTree(s, 'cowork', 'c1').sort()).toEqual(['sess-1', 'sess-2'])
  })
})
