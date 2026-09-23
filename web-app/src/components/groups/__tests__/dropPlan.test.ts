import { describe, expect, it } from 'vitest'
import { planDrop, rankPointerHits, RECENTS_DROP, type DropContext } from '../dropPlan'

const members: Record<string, string | null> = { a: 'g1', b: 'g1', c: 'g2', r1: null, r2: null }
const ctx: DropContext = {
  groupOrder: ['g1', 'g2', 'g3'],
  childrenOf: (g) => Object.keys(members).filter((k) => members[k] === g),
  groupIdOf: (i) => members[i] ?? null,
  hasItem: (i) => i in members,
}

describe('planDrop', () => {
  it('reorders groups by dropping on a group or one of its children', () => {
    expect(planDrop('grp:g3', 'grp:g1', ctx)).toEqual({ kind: 'reorderGroup', groupId: 'g3', toIndex: 0 })
    expect(planDrop('grp:g1', 'item:c', ctx)).toEqual({ kind: 'reorderGroup', groupId: 'g1', toIndex: 1 })
    expect(planDrop('grp:g1', RECENTS_DROP, ctx)).toBeNull()
  })

  it('reorders children inside a group', () => {
    expect(planDrop('item:b', 'item:a', ctx)).toEqual({ kind: 'moveItem', itemId: 'b', groupId: 'g1', toIndex: 0 })
  })

  it('moves between groups at the hovered position or to the end', () => {
    expect(planDrop('item:a', 'item:c', ctx)).toEqual({ kind: 'moveItem', itemId: 'a', groupId: 'g2', toIndex: 0 })
    expect(planDrop('item:a', 'grp:g3', ctx)).toEqual({ kind: 'moveItem', itemId: 'a', groupId: 'g3', toIndex: undefined })
    expect(planDrop('item:a', 'drop:g2', ctx)).toMatchObject({ groupId: 'g2' })
  })

  it('moves from Recents into a group and back', () => {
    expect(planDrop('item:r1', 'grp:g1', ctx)).toMatchObject({ kind: 'moveItem', itemId: 'r1', groupId: 'g1' })
    expect(planDrop('item:a', RECENTS_DROP, ctx)).toEqual({ kind: 'moveItem', itemId: 'a', groupId: null, toIndex: undefined })
    expect(planDrop('item:a', 'item:r2', ctx)).toMatchObject({ groupId: null })
  })

  it('ignores no-op drops', () => {
    expect(planDrop('item:r1', 'item:r2', ctx)).toBeNull()
    expect(planDrop('item:a', 'grp:g1', ctx)).toBeNull()
    expect(planDrop('item:a', null, ctx)).toBeNull()
    expect(planDrop('item:a', 'item:a', ctx)).toBeNull()
  })

  it('refuses ids from another surface or unknown groups', () => {
    expect(planDrop('item:home-chat', 'grp:g1', ctx)).toBeNull()
    expect(planDrop('item:a', 'grp:other-surface-group', ctx)).toBeNull()
    expect(planDrop('grp:foreign', 'grp:g1', ctx)).toBeNull()
    expect(planDrop('file:C:/x.txt', 'grp:g1', ctx)).toBeNull()
  })
})

describe('rankPointerHits', () => {
  it('prefers the innermost target under the pointer', () => {
    const hits = [{ id: 'grp:g2' }, RECENTS_DROP, { id: 'drop:g2' }, { id: 'item:c' }].map((h) =>
      typeof h === 'string' ? { id: h } : h
    )
    expect(rankPointerHits(hits).map((h) => h.id)).toEqual(['item:c', 'drop:g2', 'grp:g2', RECENTS_DROP])
  })

  it('keeps a lone group header hit', () => {
    expect(rankPointerHits([{ id: 'grp:g1' }])).toEqual([{ id: 'grp:g1' }])
  })
})
