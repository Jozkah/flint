import { describe, it, expect } from 'vitest'
import { ContentType, MessageStatus, type ThreadMessage } from '@janhq/core'
import {
  hasBranching,
  getParentId,
  getSiblings,
  getVersionInfo,
  pickActiveChild,
  computeActivePath,
  backfillParentIds,
  makeSibling,
  withActiveChild,
  repairDetachedAssistants,
  planContinuation,
  removeFromTree,
  repairDanglingParents,
} from '../message-branching'

let clock = 1000
function msg(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  metadata?: Record<string, unknown>
): ThreadMessage {
  const t = ++clock
  return {
    id,
    object: 'thread.message',
    thread_id: 'thr',
    role: role as ThreadMessage['role'],
    content: [{ type: ContentType.Text, text: { value: text, annotations: [] } }],
    status: MessageStatus.Ready,
    created_at: t,
    completed_at: t,
    metadata,
  }
}

const ids = (ms: ThreadMessage[]) => ms.map((m) => m.id)

describe('message-branching', () => {
  it('treats legacy un-branched threads as linear', () => {
    const m = [msg('a', 'user', 'hi'), msg('b', 'assistant', 'yo')]
    expect(hasBranching(m)).toBe(false)
    expect(ids(computeActivePath(m))).toEqual(['a', 'b'])
    expect(getVersionInfo(m, m[0])).toEqual({ index: 1, count: 1 })
  })

  it('backfills parent ids along a linear path, then is idempotent', () => {
    const m = [msg('a', 'user', 'hi'), msg('b', 'assistant', 'yo')]
    const filled = backfillParentIds(m)
    expect(filled).toHaveLength(2)
    expect(getParentId(filled[0])).toBeNull()
    expect(getParentId(filled[1])).toBe('a')
    expect(backfillParentIds(filled)).toEqual([])
  })

  it('makeSibling shares the parent and clears active/error state', () => {
    const u = msg('a', 'user', 'orig', { parentId: null })
    const sib = makeSibling(u, { id: 'a2', createdAt: 5000, text: 'edited' })
    expect(getParentId(sib)).toBeNull()
    expect(sib.id).toBe('a2')
    expect(sib.content[0].text?.value).toBe('edited')
    expect((sib.metadata as Record<string, unknown>).activeChildId).toBeUndefined()
  })

  it('makeSibling keeps the images of an edited message but not its reasoning', () => {
    const u = msg('a', 'user', 'orig', { parentId: null })
    u.content.push(
      {
        type: ContentType.Image,
        image_url: { url: 'data:image/png;base64,AAAA', detail: 'auto' },
      } as never,
      { type: ContentType.Reasoning, text: { value: 'why', annotations: [] } } as never
    )
    const sib = makeSibling(u, { id: 'a2', createdAt: 5000, text: 'edited' })
    expect(sib.content.map((c) => c.type)).toEqual([
      ContentType.Text,
      ContentType.Image,
    ])
    expect(sib.content[0].text?.value).toBe('edited')
    // The source keeps its own content untouched.
    expect(u.content).toHaveLength(3)
  })

  it('newest sibling is active by default; activeChildId overrides', () => {
    // root user a -> assistant b1 (v1) and b2 (v2, newer)
    const a = msg('a', 'user', 'q', { parentId: null })
    const b1 = msg('b1', 'assistant', 'first', { parentId: 'a' })
    const b2 = msg('b2', 'assistant', 'second', { parentId: 'a' })
    let m = [a, b1, b2]
    expect(pickActiveChild(m, a)?.id).toBe('b2')
    expect(ids(computeActivePath(m))).toEqual(['a', 'b2'])

    // pin a's active child back to b1
    m = [withActiveChild(a, 'b1'), b1, b2]
    expect(pickActiveChild(m, m[0])?.id).toBe('b1')
    expect(ids(computeActivePath(m))).toEqual(['a', 'b1'])
  })

  it('reconstructs a full downstream branch, not just the forked node', () => {
    // a -> b1 -> c1 (branch 1);  a -> b2 -> c2 (branch 2, newer)
    const a = msg('a', 'user', 'q', { parentId: null })
    const b1 = msg('b1', 'assistant', 'a1', { parentId: 'a' })
    const c1 = msg('c1', 'user', 'follow1', { parentId: 'b1' })
    const b2 = msg('b2', 'assistant', 'a2', { parentId: 'a' })
    const c2 = msg('c2', 'user', 'follow2', { parentId: 'b2' })
    const m = [a, b1, c1, b2, c2]
    expect(ids(computeActivePath(m))).toEqual(['a', 'b2', 'c2'])
    expect(ids(computeActivePath([withActiveChild(a, 'b1'), b1, c1, b2, c2]))).toEqual([
      'a',
      'b1',
      'c1',
    ])
  })

  it('reports version index/count among siblings sorted by time', () => {
    const a = msg('a', 'user', 'q', { parentId: null })
    const b1 = msg('b1', 'assistant', 'a1', { parentId: 'a' })
    const b2 = msg('b2', 'assistant', 'a2', { parentId: 'a' })
    const m = [a, b1, b2]
    expect(getSiblings(m, b1).map((x) => x.id)).toEqual(['b1', 'b2'])
    expect(getVersionInfo(m, b1)).toEqual({ index: 1, count: 2 })
    expect(getVersionInfo(m, b2)).toEqual({ index: 2, count: 2 })
  })

  it('selects the active root among sibling roots', () => {
    const a1 = msg('a1', 'user', 'q1', { parentId: null })
    const a2 = msg('a2', 'user', 'q2', { parentId: null })
    const m = [a1, a2]
    expect(ids(computeActivePath(m))).toEqual(['a2'])
    expect(ids(computeActivePath(m, 'a1'))).toEqual(['a1'])
  })

  describe('repairDetachedAssistants', () => {
    it('re-parents a detached assistant to the preceding user turn', () => {
      // u1 -> a1(BROKEN: parentId null) -> u2(-> a1); a1 is a phantom root that
      // computeActivePath drops, so only u1 renders.
      const u1 = msg('u1', 'user', 'hi', { parentId: null })
      const a1 = msg('a1', 'assistant', 'reply', { parentId: null })
      const u2 = msg('u2', 'user', 'again', { parentId: 'a1' })
      const before = [u1, a1, u2]
      // Broken: a1 is a second null-parent root, so computeActivePath picks it
      // as the (newest) root and drops the real u1 turn from the path.
      expect(ids(computeActivePath(before))).toEqual(['a1', 'u2'])

      const repaired = repairDetachedAssistants(before)
      expect(repaired).toHaveLength(1)
      expect(repaired[0].id).toBe('a1')
      expect(getParentId(repaired[0])).toBe('u1')

      const fixed = before.map((m) => repaired.find((r) => r.id === m.id) ?? m)
      expect(ids(computeActivePath(fixed))).toEqual(['u1', 'a1', 'u2'])
    })

    it('is a no-op on healthy branched threads', () => {
      const u1 = msg('u1', 'user', 'hi', { parentId: null })
      const a1 = msg('a1', 'assistant', 'reply', { parentId: 'u1' })
      expect(repairDetachedAssistants([u1, a1])).toEqual([])
    })

    it('is a no-op on legacy un-branched threads', () => {
      const m = [msg('a', 'user', 'hi'), msg('b', 'assistant', 'yo')]
      expect(repairDetachedAssistants(m)).toEqual([])
    })

    it('leaves a detached assistant with no preceding user untouched', () => {
      const a1 = msg('a1', 'assistant', 'orphan', { parentId: null })
      const u1 = msg('u1', 'user', 'hi', { parentId: null })
      expect(repairDetachedAssistants([a1, u1])).toEqual([])
    })

    it('repairs the real-world pattern: undefined-parent assistants with the next user mis-linked to the previous user', () => {
      // Reproduces thread 03d08945: branched thread where assistant replies lost
      // their parentId entirely (undefined) and each following user was linked to
      // the PREVIOUS user, skipping the reply. Repair must re-parent the reply AND
      // re-link the following user onto it so the whole tail rejoins the path.
      const u1 = msg('u1', 'user', 'q1', { parentId: null })
      const a1 = msg('a1', 'assistant', 'r1', { parentId: 'u1' })
      const u2 = msg('u2', 'user', 'q2', { parentId: 'a1' })
      const a2 = msg('a2', 'assistant', 'r2') // parentId missing (undefined)
      const u3 = msg('u3', 'user', 'q3', { parentId: 'u2' }) // mis-linked to u2
      const a3 = msg('a3', 'assistant', 'r3') // parentId missing (undefined)
      const before = [u1, a1, u2, a2, u3, a3]
      // Broken: a2 and a3 are dropped, only users survive after u2.
      expect(ids(computeActivePath(before))).toEqual(['u1', 'a1', 'u2', 'u3'])

      const repaired = repairDetachedAssistants(before)
      const fixed = before.map((m) => repaired.find((r) => r.id === m.id) ?? m)
      expect(ids(computeActivePath(fixed))).toEqual([
        'u1',
        'a1',
        'u2',
        'a2',
        'u3',
        'a3',
      ])
      // Idempotent: a second pass finds nothing to write.
      expect(repairDetachedAssistants(fixed)).toEqual([])
    })

    it('repairs multiple detached assistants to their nearest user by created_at', () => {
      const u1 = msg('u1', 'user', 'q1', { parentId: null })
      const a1 = msg('a1', 'assistant', 'r1', { parentId: null })
      const u2 = msg('u2', 'user', 'q2', { parentId: 'a1' })
      const a2 = msg('a2', 'assistant', 'r2', { parentId: null })
      const repaired = repairDetachedAssistants([u1, a1, u2, a2])
      const parentOf = (id: string) =>
        getParentId(repaired.find((r) => r.id === id)!)
      expect(repaired.map((r) => r.id).sort()).toEqual(['a1', 'a2'])
      expect(parentOf('a1')).toBe('u1')
      expect(parentOf('a2')).toBe('u2')
    })
  })

  // janhq/jan#8495: replies present in messages.jsonl but missing from the UI.
  describe('removeFromTree', () => {
    it('reproduces the loss: dropping a row strands everything below it', () => {
      const u1 = msg('u1', 'user', 'q1', { parentId: null })
      const a1 = msg('a1', 'assistant', 'r1', { parentId: 'u1' })
      const u2 = msg('u2', 'user', 'q2', { parentId: 'a1' })
      const a2 = msg('a2', 'assistant', 'r2', { parentId: 'u2' })
      const naive = [u1, u2, a2] // a1 deleted the old way
      expect(ids(computeActivePath(naive))).toEqual(['u1'])
    })

    it('re-parents the children of a deleted message onto its parent', () => {
      const u1 = msg('u1', 'user', 'q1', { parentId: null, activeChildId: 'a1' })
      const a1 = msg('a1', 'assistant', 'r1', { parentId: 'u1' })
      const u2 = msg('u2', 'user', 'q2', { parentId: 'a1' })
      const a2 = msg('a2', 'assistant', 'r2', { parentId: 'u2' })
      const all = [u1, a1, u2, a2]

      const writes = removeFromTree(all, ['a1'])
      const after = all
        .filter((m) => m.id !== 'a1')
        .map((m) => writes.find((w) => w.id === m.id) ?? m)

      expect(ids(computeActivePath(after))).toEqual(['u1', 'u2', 'a2'])
      // The parent's selection followed the child that took the removed
      // message's place, instead of dangling.
      expect(after.find((m) => m.id === 'u1')?.metadata?.activeChildId).toBe('u2')
    })

    it('keeps the tail of a turn whose errored empty reply is cleaned up', () => {
      // An errored generation left an empty assistant row, and the next user
      // turn was linked to it because it was last on the active path.
      const u1 = msg('u1', 'user', 'q1', { parentId: null })
      const empty = msg('e1', 'assistant', '', { parentId: 'u1' })
      const u2 = msg('u2', 'user', 'retry', { parentId: 'e1' })
      const a2 = msg('a2', 'assistant', 'r2', { parentId: 'u2' })
      const all = [u1, empty, u2, a2]

      const writes = removeFromTree(all, ['e1'])
      const after = all
        .filter((m) => m.id !== 'e1')
        .map((m) => writes.find((w) => w.id === m.id) ?? m)

      expect(ids(computeActivePath(after))).toEqual(['u1', 'u2', 'a2'])
    })

    it('walks past a chain of removed messages', () => {
      const u1 = msg('u1', 'user', 'q1', { parentId: null })
      const e1 = msg('e1', 'assistant', '', { parentId: 'u1' })
      const e2 = msg('e2', 'assistant', '', { parentId: 'e1' })
      const u2 = msg('u2', 'user', 'q2', { parentId: 'e2' })
      const all = [u1, e1, e2, u2]

      const writes = removeFromTree(all, ['e1', 'e2'])
      expect(writes.find((w) => w.id === 'u2')?.metadata?.parentId).toBe('u1')
    })

    it('leaves a sibling selection that did not point at the removed message', () => {
      const u1 = msg('u1', 'user', 'q1', { parentId: null, activeChildId: 'a1b' })
      const a1a = msg('a1a', 'assistant', 'old', { parentId: 'u1' })
      const a1b = msg('a1b', 'assistant', 'new', { parentId: 'u1' })
      const u2 = msg('u2', 'user', 'q2', { parentId: 'a1a' })

      const writes = removeFromTree([u1, a1a, a1b, u2], ['a1a'])
      expect(writes.find((w) => w.id === 'u1')).toBeUndefined()
    })

    it('is a no-op on legacy threads and when nothing is removed', () => {
      const u1 = msg('u1', 'user', 'q1')
      const a1 = msg('a1', 'assistant', 'r1')
      expect(removeFromTree([u1, a1], ['a1'])).toEqual([])
      const b1 = msg('b1', 'user', 'q1', { parentId: null })
      expect(removeFromTree([b1], [])).toEqual([])
    })
  })

  describe('repairDanglingParents', () => {
    it('re-attaches a thread already damaged by the old delete path', () => {
      const u1 = msg('u1', 'user', 'q1', { parentId: null, activeChildId: 'gone' })
      const u2 = msg('u2', 'user', 'q2', { parentId: 'gone' })
      const a2 = msg('a2', 'assistant', 'r2', { parentId: 'u2' })
      const before = [u1, u2, a2]
      expect(ids(computeActivePath(before))).toEqual(['u1'])

      const writes = repairDanglingParents(before)
      const fixed = before.map((m) => writes.find((w) => w.id === m.id) ?? m)

      expect(ids(computeActivePath(fixed))).toEqual(['u1', 'u2', 'a2'])
      expect(repairDanglingParents(fixed)).toEqual([])
    })

    it('is a no-op on a healthy branched thread', () => {
      const u1 = msg('u1', 'user', 'q1', { parentId: null })
      const a1 = msg('a1', 'assistant', 'r1', { parentId: 'u1' })
      expect(repairDanglingParents([u1, a1])).toEqual([])
    })
  })

  describe('planContinuation', () => {
    it('inherits the stopped partial parent and marks it for deletion', () => {
      const u = msg('u1', 'user', 'q', { parentId: null })
      const partial = msg('a1', 'assistant', 'half', {
        parentId: 'u1',
        stopped: true,
      })
      const plan = planContinuation([u, partial], 'a2', 'a1', null)
      expect(plan).toEqual({ parentId: 'u1', deletePartialId: 'a1' })
    })

    it('applying the plan leaves the parent with a single child (no fork)', () => {
      const u = msg('u1', 'user', 'q', { parentId: null })
      const partial = msg('a1', 'assistant', 'half', {
        parentId: 'u1',
        stopped: true,
      })
      const reply = msg('a2', 'assistant', 'half and rest', { parentId: 'u1' })
      const plan = planContinuation([u, partial], reply.id, 'a1', null)

      let messages = [u, partial, reply]
      messages = messages.map((m) =>
        m.id === plan.parentId ? withActiveChild(m, reply.id) : m
      )
      if (plan.deletePartialId) {
        messages = messages.filter((m) => m.id !== plan.deletePartialId)
      }

      expect(getSiblings(messages, reply)).toHaveLength(1)
      expect(getVersionInfo(messages, reply)).toEqual({ index: 1, count: 1 })
      expect(ids(computeActivePath(messages))).toEqual(['u1', 'a2'])
    })

    it('falls back to the pending parent when no partial is targeted', () => {
      const u = msg('u1', 'user', 'q', { parentId: null })
      const plan = planContinuation([u], 'a2', null, 'u1')
      expect(plan).toEqual({ parentId: 'u1', deletePartialId: null })
    })

    it('does not delete when the partial id is stale (not found)', () => {
      const u = msg('u1', 'user', 'q', { parentId: null })
      const plan = planContinuation([u], 'a2', 'gone', 'u1')
      expect(plan).toEqual({ parentId: 'u1', deletePartialId: null })
    })

    it('does not delete when the reply reuses the partial id', () => {
      const u = msg('u1', 'user', 'q', { parentId: null })
      const partial = msg('a1', 'assistant', 'half', { parentId: 'u1' })
      const plan = planContinuation([u, partial], 'a1', 'a1', null)
      expect(plan).toEqual({ parentId: 'u1', deletePartialId: null })
    })
  })
})
