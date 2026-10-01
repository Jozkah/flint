import { describe, it, expect } from 'vitest'
import { ContentType, MessageStatus, type ThreadMessage } from '@janhq/core'
import {
  activePathOf,
  activeRootIdOf,
  allBranchPaths,
} from '../message-branching'

let clock = 0
const msg = (
  id: string,
  role: 'user' | 'assistant',
  parent: string | null | undefined,
  extra: Record<string, unknown> = {}
): ThreadMessage => ({
  id,
  object: 'thread.message',
  thread_id: 't',
  role: role as ThreadMessage['role'],
  content: [{ type: ContentType.Text, text: { value: id, annotations: [] } }],
  status: MessageStatus.Ready,
  created_at: ++clock,
  completed_at: clock,
  metadata: parent === undefined ? extra : { parentId: parent, ...extra },
})
const ids = (m: ThreadMessage[]) => m.map((x) => x.id)

// u1 -> a1 (old), a1b (regenerated, newer) -> u2 under a1b
const branched = () => [
  msg('u1', 'user', null),
  msg('a1', 'assistant', 'u1'),
  msg('a1b', 'assistant', 'u1'),
  msg('u2', 'user', 'a1b'),
]

describe('activePathOf', () => {
  it('drops the versions that are not on screen', () => {
    expect(ids(activePathOf(branched()))).toEqual(['u1', 'a1b', 'u2'])
  })

  it('follows activeChildId set on the parent', () => {
    const m = branched()
    m[0] = { ...m[0], metadata: { parentId: null, activeChildId: 'a1' } }
    expect(ids(activePathOf(m))).toEqual(['u1', 'a1'])
  })

  it('uses the root the thread selected', () => {
    const m = [msg('r1', 'user', null), msg('r2', 'user', null)]
    expect(ids(activePathOf(m, { activeRootId: 'r1' }))).toEqual(['r1'])
    expect(ids(activePathOf(m))).toEqual(['r2'])
  })

  it('returns a linear thread unchanged', () => {
    const m = [msg('a', 'user', undefined), msg('b', 'assistant', undefined)]
    expect(activePathOf(m)).toBe(m)
  })

  it('ignores a non-string activeRootId', () => {
    expect(activeRootIdOf({ activeRootId: 3 })).toBeUndefined()
    expect(activeRootIdOf(undefined)).toBeUndefined()
  })
})

describe('allBranchPaths', () => {
  it('lists every root-to-leaf path, oldest branch first', () => {
    expect(allBranchPaths(branched()).map(ids)).toEqual([
      ['u1', 'a1'],
      ['u1', 'a1b', 'u2'],
    ])
  })

  it('is one path for a linear thread and none for an empty one', () => {
    const m = [msg('a', 'user', undefined), msg('b', 'assistant', undefined)]
    expect(allBranchPaths(m).map(ids)).toEqual([['a', 'b']])
    expect(allBranchPaths([])).toEqual([])
  })

  it('does not loop on a parent cycle', () => {
    const m = [msg('x', 'user', 'y'), msg('y', 'assistant', 'x')]
    expect(() => allBranchPaths(m)).not.toThrow()
  })
})
