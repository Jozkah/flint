import { describe, expect, it } from 'vitest'
import {
  createGroup,
  deleteGroup,
  emptyGroupsState,
  layoutSurface,
  moveItem,
  sanitizeGroupsState,
  setGroupParent,
} from '../domain'
import { GROUPS_SCHEMA_VERSION, MAX_GROUP_DEPTH } from '../types'

const base = () => {
  let s = emptyGroupsState()
  s = createGroup(s, 'home', { id: 'a', name: 'A', now: 1 })
  s = createGroup(s, 'home', { id: 'b', name: 'B', now: 2, parentId: 'a' })
  s = createGroup(s, 'home', { id: 'c', name: 'C', now: 3, parentId: 'b' })
  return s
}

describe('nested groups', () => {
  it('is schema v2 with depth cap 3', () => {
    expect(GROUPS_SCHEMA_VERSION).toBe(2)
    expect(MAX_GROUP_DEPTH).toBe(3)
  })

  it('lays out sub-groups under their parent', () => {
    const s = base().surfaces.home
    const layout = layoutSurface(s, [], (x: string) => x)
    expect(layout.groups.map((g) => g.group.id)).toEqual(['a'])
    expect(layout.groups[0].subgroups[0].group.id).toBe('b')
    expect(layout.groups[0].subgroups[0].subgroups[0].group.id).toBe('c')
  })

  it('refuses creating beyond the depth cap', () => {
    expect(() =>
      createGroup(base(), 'home', { id: 'd', name: 'D', now: 4, parentId: 'c' })
    ).toThrow()
  })

  it('refuses a cycle and a move into itself', () => {
    expect(() => setGroupParent(base(), 'home', 'a', 'c', 5)).toThrow()
    expect(() => setGroupParent(base(), 'home', 'a', 'a', 5)).toThrow()
  })

  it('refuses a move that pushes a subtree past the cap', () => {
    let s = base()
    s = createGroup(s, 'home', { id: 'x', name: 'X', now: 6 })
    s = createGroup(s, 'home', { id: 'y', name: 'Y', now: 7, parentId: 'x' })
    // a(b(c)) is height 3; under y (depth 2) would reach depth 5
    expect(() => setGroupParent(s, 'home', 'a', 'y', 8)).toThrow()
    // a lone leaf fits under y (depth 3)
    s = createGroup(s, 'home', { id: 'z', name: 'Z', now: 9 })
    const moved = setGroupParent(s, 'home', 'z', 'y', 10)
    expect(moved.surfaces.home.groups.find((g) => g.id === 'z')?.parentId).toBe('y')
  })

  it('delete re-parents children and never loses chats', () => {
    let s = base()
    s = moveItem(s, 'home', 'chat1', 'b')
    s = moveItem(s, 'home', 'chat2', 'c')
    s = deleteGroup(s, 'home', 'b')
    const groups = s.surfaces.home.groups
    expect(groups.find((g) => g.id === 'c')?.parentId).toBe('a')
    // chat in the deleted group goes to Recents, chat in the surviving child stays
    const layout = layoutSurface(s.surfaces.home, ['chat1', 'chat2'], (x) => x)
    expect(layout.recents).toEqual(['chat1'])
    expect(layout.groups[0].subgroups[0].children).toEqual(['chat2'])
  })

  it('reads v1 data (no parentId) as top-level', () => {
    const v1 = {
      version: 1,
      surfaces: {
        home: {
          groups: [{ id: 'g', name: 'G', position: 0, collapsed: false, folderBindings: [] }],
          memberships: {},
          contexts: {},
        },
      },
    }
    expect(sanitizeGroupsState(v1).surfaces.home.groups[0].parentId).toBeNull()
  })

  it('repairs corrupt parents: missing, cyclic, too deep', () => {
    const g = (id: string, parentId: string | null, position: number) => ({
      id,
      name: id,
      position,
      collapsed: false,
      folderBindings: [],
      parentId,
    })
    const raw = {
      surfaces: {
        home: {
          groups: [
            g('m', 'ghost', 0),
            g('p', 'q', 1),
            g('q', 'p', 2),
            g('d1', null, 3),
            g('d2', 'd1', 4),
            g('d3', 'd2', 5),
            g('d4', 'd3', 6),
          ],
        },
      },
    }
    const home = sanitizeGroupsState(raw).surfaces.home
    const parent = (id: string) => home.groups.find((x) => x.id === id)?.parentId
    expect(home.groups).toHaveLength(7)
    expect(parent('m')).toBeNull()
    expect([parent('p'), parent('q')]).toContain(null)
    expect(parent('d4')).toBeNull()
    expect(parent('d3')).toBe('d2')
    const layout = layoutSurface(home, [], (x: string) => x)
    const count = (ls: typeof layout.groups): number =>
      ls.reduce((n, l) => n + 1 + count(l.subgroups), 0)
    expect(count(layout.groups)).toBe(7)
  })
})
