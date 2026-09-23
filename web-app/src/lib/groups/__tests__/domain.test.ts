import { describe, expect, it } from 'vitest'
import {
  canonicalKey,
  createGroup,
  deleteGroup,
  emptyGroupsState,
  layoutSurface,
  moveItem,
  pruneMissingItems,
  renameGroup,
  reorderGroup,
  sanitizeGroupsState,
  setGroupCollapsed,
  setGroupFolders,
} from '../domain'
import type { GroupsState } from '../types'

const mk = (names: string[], surface: 'home' | 'cowork' | 'rooms' = 'home') =>
  names.reduce<GroupsState>(
    (s, name, i) => createGroup(s, surface, { id: `g${i}`, name, now: i }),
    emptyGroupsState()
  )

const ids = (xs: { id: string }[]) => xs.map((x) => x.id)
const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }))

describe('namespaces', () => {
  it('keeps surfaces independent', () => {
    let s = mk(['H'])
    s = createGroup(s, 'cowork', { id: 'c0', name: 'C', now: 0 })
    s = moveItem(s, 'home', 'a', 'g0')
    expect(s.surfaces.cowork.memberships).toEqual({})
    expect(s.surfaces.rooms.groups).toEqual([])
    expect(() => moveItem(s, 'rooms', 'a', 'g0')).toThrow()
  })
})

describe('group lifecycle', () => {
  it('creates, renames, collapses, reorders, deletes', () => {
    let s = mk(['One', 'Two', 'Three'])
    s = renameGroup(s, 'home', 'g1', '  Second  ', 9)
    expect(s.surfaces.home.groups[1].name).toBe('Second')
    expect(() => renameGroup(s, 'home', 'g1', '   ', 9)).toThrow()
    s = setGroupCollapsed(s, 'home', 'g0', true)
    expect(s.surfaces.home.groups[0].collapsed).toBe(true)
    s = reorderGroup(s, 'home', 'g2', 0)
    expect(layoutSurface(s.surfaces.home, [], (x: { id: string }) => x.id).groups.map((g) => g.group.id)).toEqual(['g2', 'g0', 'g1'])
    expect(s.surfaces.home.groups.map((g) => g.position).sort()).toEqual([0, 1, 2])
    s = deleteGroup(s, 'home', 'g0')
    expect(s.surfaces.home.groups).toHaveLength(2)
  })

  it('allows duplicate names and keeps empty groups', () => {
    const s = mk(['Same', 'Same'])
    const l = layoutSurface(s.surfaces.home, items, (x) => x.id)
    expect(l.groups).toHaveLength(2)
    expect(l.groups.every((g) => g.children.length === 0)).toBe(true)
    expect(ids(l.recents)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('membership', () => {
  it('enforces one group per item and orders children', () => {
    let s = mk(['X', 'Y'])
    s = moveItem(s, 'home', 'a', 'g0')
    s = moveItem(s, 'home', 'b', 'g0', 0)
    s = moveItem(s, 'home', 'a', 'g1')
    const l = layoutSurface(s.surfaces.home, items, (x) => x.id)
    expect(ids(l.groups[0].children)).toEqual(['b'])
    expect(ids(l.groups[1].children)).toEqual(['a'])
    expect(ids(l.recents)).toEqual(['c', 'd'])
  })

  it('reorders inside a group and returns to Recents', () => {
    let s = mk(['X'])
    for (const id of ['a', 'b', 'c']) s = moveItem(s, 'home', id, 'g0')
    s = moveItem(s, 'home', 'c', 'g0', 0)
    expect(ids(layoutSurface(s.surfaces.home, items, (x) => x.id).groups[0].children)).toEqual(['c', 'a', 'b'])
    s = moveItem(s, 'home', 'a', null)
    const l = layoutSurface(s.surfaces.home, items, (x) => x.id)
    expect(ids(l.groups[0].children)).toEqual(['c', 'b'])
    expect(ids(l.recents)).toEqual(['a', 'd'])
  })

  it('deleting a group ungroups members without deleting them', () => {
    let s = mk(['X'])
    s = moveItem(s, 'home', 'a', 'g0')
    s = deleteGroup(s, 'home', 'g0')
    expect(ids(layoutSurface(s.surfaces.home, items, (x) => x.id).recents)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('prunes memberships of deleted items', () => {
    let s = mk(['X'])
    s = moveItem(s, 'home', 'a', 'g0')
    s = moveItem(s, 'home', 'b', 'g0')
    s = pruneMissingItems(s, 'home', new Set(['b']))
    expect(Object.keys(s.surfaces.home.memberships)).toEqual(['b'])
    expect(s.surfaces.home.memberships.b.position).toBe(0)
    expect(pruneMissingItems(s, 'home', new Set(['b']))).toBe(s)
  })
})

describe('folders', () => {
  it('stores multiple folders and rejects duplicates after canonicalization', () => {
    let s = mk(['X'])
    s = setGroupFolders(s, 'home', 'g0', [
      { path: 'C:\\Work', canonicalPath: 'C:\\Work', displayName: 'Work' },
      { path: 'c:/work/', canonicalPath: 'c:/work/', displayName: 'work' },
      { path: '\\\\?\\C:\\Work', canonicalPath: '\\\\?\\C:\\Work', displayName: 'Work' },
      { path: '/srv/a', canonicalPath: '/srv/a', displayName: 'a', available: false },
      { path: '/srv/A', canonicalPath: '/srv/A', displayName: 'A' },
    ], 1)
    expect(s.surfaces.home.groups[0].folderBindings.map((b) => b.displayName)).toEqual(['Work', 'a', 'A'])
    expect(s.surfaces.home.groups[0].folderBindings[1].available).toBe(false)
  })

  it('canonicalKey folds UNC and verbatim prefixes', () => {
    expect(canonicalKey('\\\\?\\UNC\\srv\\Share\\x')).toBe('//srv/share/x')
    expect(canonicalKey('\\\\srv\\share\\X\\')).toBe('//srv/share/x')
  })
})

describe('recovery', () => {
  it('returns empty state for garbage', () => {
    expect(sanitizeGroupsState('nope').surfaces.home.groups).toEqual([])
    expect(sanitizeGroupsState({ surfaces: 5 }).surfaces.rooms.groups).toEqual([])
  })

  it('drops corrupt groups, orphaned memberships fall back to Recents', () => {
    const s = sanitizeGroupsState({
      version: 1,
      surfaces: {
        home: {
          groups: [
            { id: 'g0', name: 'Ok', position: 3 },
            { name: 'no id' },
            { id: 'g0', name: 'dupe' },
            null,
          ],
          memberships: {
            a: { groupId: 'g0', position: 5 },
            b: { groupId: 'gone', position: 0 },
            c: 'bad',
          },
        },
      },
    })
    expect(s.surfaces.home.groups).toHaveLength(1)
    expect(s.surfaces.home.groups[0].position).toBe(0)
    const l = layoutSurface(s.surfaces.home, items, (x) => x.id)
    expect(ids(l.groups[0].children)).toEqual(['a'])
    expect(ids(l.recents)).toEqual(['b', 'c', 'd'])
  })

  it('layout never hides items whose group vanished', () => {
    let s = mk(['X'])
    s = moveItem(s, 'home', 'a', 'g0')
    const broken = { ...s.surfaces.home, groups: [] }
    expect(ids(layoutSurface(broken, items, (x) => x.id).recents)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('scale', () => {
  it('handles 100 groups and 2000 items quickly', () => {
    let s = emptyGroupsState()
    for (let i = 0; i < 100; i++) s = createGroup(s, 'home', { id: `g${i}`, name: `G${i}`, now: i })
    const many = Array.from({ length: 2000 }, (_, i) => ({ id: `i${i}` }))
    for (let i = 0; i < 1500; i++) s = moveItem(s, 'home', `i${i}`, `g${i % 100}`)
    const t0 = performance.now()
    const l = layoutSurface(s.surfaces.home, many, (x) => x.id)
    const moved = moveItem(s, 'home', 'i0', 'g50', 0)
    const dt = performance.now() - t0
    expect(l.recents).toHaveLength(500)
    expect(moved.surfaces.home.memberships.i0.groupId).toBe('g50')
    expect(dt).toBeLessThan(250)
  })
})
