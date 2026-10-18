import { describe, expect, it } from 'vitest'
import {
  buildNestTree,
  countNested,
  isStickyStatus,
  splitNested,
  type NestStatus,
} from '@/lib/nesting'

describe('buildNestTree', () => {
  it('lists items without parents as roots in input order', () => {
    expect(
      buildNestTree([{ id: 'b' }, { id: 'a' }, { id: 'c', parentId: null }])
    ).toEqual([
      { id: 'b', nested: [] },
      { id: 'a', nested: [] },
      { id: 'c', nested: [] },
    ])
  })

  it('nests children under a parent in the list, newest first', () => {
    const tree = buildNestTree([
      { id: 'p', updated: 1 },
      { id: 'old', parentId: 'p', updated: 5 },
      { id: 'new', parentId: 'p', updated: 9 },
    ])
    expect(tree).toEqual([{ id: 'p', nested: ['new', 'old'] }])
  })

  it('keeps a child listed before its parent under that parent', () => {
    const tree = buildNestTree([
      { id: 'c', parentId: 'p', updated: 9 },
      { id: 'x', updated: 8 },
      { id: 'p', updated: 1 },
    ])
    expect(tree).toEqual([
      { id: 'x', nested: [] },
      { id: 'p', nested: ['c'] },
    ])
  })

  it('shows orphans (parent deleted or in another list) as roots', () => {
    const tree = buildNestTree([
      { id: 'a', parentId: 'gone' },
      { id: 'b', parentId: 'gone' },
    ])
    expect(tree.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('promotes children when their parent is removed from the list', () => {
    const items = [
      { id: 'p', updated: 1 },
      { id: 'c1', parentId: 'p', updated: 2 },
      { id: 'c2', parentId: 'p', updated: 3 },
    ]
    expect(buildNestTree(items)).toHaveLength(1)
    const after = buildNestTree(items.filter((i) => i.id !== 'p'))
    expect(after).toEqual([
      { id: 'c1', nested: [] },
      { id: 'c2', nested: [] },
    ])
  })

  it('caps the depth: grandchildren are listed with the root', () => {
    const tree = buildNestTree([
      { id: 'root', updated: 1 },
      { id: 'child', parentId: 'root', updated: 2 },
      { id: 'grand', parentId: 'child', updated: 3 },
      { id: 'great', parentId: 'grand', updated: 4 },
    ])
    expect(tree).toEqual([{ id: 'root', nested: ['great', 'grand', 'child'] }])
  })

  it('breaks a cycle at its newest member without hanging', () => {
    const tree = buildNestTree([
      { id: 'a', parentId: 'b', updated: 1 },
      { id: 'b', parentId: 'c', updated: 3 },
      { id: 'c', parentId: 'a', updated: 2 },
    ])
    expect(tree).toEqual([{ id: 'b', nested: ['c', 'a'] }])
  })

  it('ignores a self link and duplicate ids', () => {
    const tree = buildNestTree([
      { id: 'a', parentId: 'a' },
      { id: 'a', parentId: 'a' },
    ])
    expect(tree).toEqual([{ id: 'a', nested: [] }])
  })
})

describe('splitNested', () => {
  const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']
  it('shows everything at or under the limit', () => {
    expect(splitNested(ids.slice(0, 3), { expanded: false, sticky: () => false })).toEqual({
      shown: ['n1', 'n2', 'n3'],
      hidden: [],
    })
  })
  it('folds the rest behind the summary', () => {
    expect(splitNested(ids, { expanded: false, sticky: () => false })).toEqual({
      shown: ['n1', 'n2', 'n3'],
      hidden: ['n4', 'n5', 'n6'],
    })
  })
  it('never hides a sticky row (selected, working, waiting)', () => {
    const out = splitNested(ids, { expanded: false, sticky: (id) => id === 'n5' })
    expect(out.shown).toEqual(['n1', 'n2', 'n3', 'n5'])
    expect(out.hidden).toEqual(['n4', 'n6'])
  })
  it('shows all when expanded', () => {
    expect(splitNested(ids, { expanded: true, sticky: () => false }).hidden).toEqual([])
  })
})

describe('countNested', () => {
  it('counts new, working and waiting', () => {
    const s: Record<string, NestStatus> = { a: 'recent', b: 'active', c: 'wait', d: 'none', e: 'recent' }
    expect(countNested(Object.keys(s), (id) => s[id])).toEqual({
      total: 5,
      fresh: 2,
      working: 1,
      waiting: 1,
    })
  })
})

describe('isStickyStatus', () => {
  it('is sticky when selected, working or waiting', () => {
    expect(isStickyStatus('none', true)).toBe(true)
    expect(isStickyStatus('active', false)).toBe(true)
    expect(isStickyStatus('wait', false)).toBe(true)
    expect(isStickyStatus('recent', false)).toBe(false)
  })
})
