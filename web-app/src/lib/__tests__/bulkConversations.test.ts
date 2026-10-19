import { describe, expect, it, vi } from 'vitest'
import {
  BulkKept,
  countKinds,
  emptySnapshot,
  planBulk,
  planCounts,
  runBulk,
  skipCount,
  type BulkItem,
  type BulkKind,
  type BulkSnapshot,
} from '../bulkConversations'

const item = (kind: BulkKind, id: string, over: Partial<BulkItem> = {}): BulkItem => ({
  kind,
  id,
  title: id,
  ...over,
})

const snapshot = (): BulkSnapshot => ({
  ...emptySnapshot(),
  thread: [
    item('thread', 't1'),
    item('thread', 't2', { pinned: true }),
    item('thread', 't3', { active: true }),
  ],
  cowork: [item('cowork', 'c1'), item('cowork', 'c2', { active: true })],
  room: [item('room', 'r1')],
  campaign: [item('campaign', 'k1'), item('campaign', 'k2', { active: true })],
})

describe('countKinds', () => {
  it('counts totals, pinned and running per kind', () => {
    const c = countKinds(snapshot())
    expect(c.thread).toEqual({ total: 3, pinned: 1, active: 1 })
    expect(c.cowork).toEqual({ total: 2, pinned: 0, active: 1 })
    expect(c.room.total).toBe(1)
    expect(c.campaign.total).toBe(2)
  })
})

describe('planBulk', () => {
  const all = new Set<BulkKind>(['thread', 'cowork', 'room', 'campaign'])

  it('selects nothing when no kind is ticked', () => {
    const plan = planBulk({
      snapshot: snapshot(),
      kinds: new Set(),
      action: 'delete',
      keepPinned: false,
    })
    expect(plan.items).toEqual([])
    expect(plan.skipped).toEqual([])
  })

  it('skips running items always and pinned ones only when asked', () => {
    const keep = planBulk({
      snapshot: snapshot(),
      kinds: new Set<BulkKind>(['thread']),
      action: 'delete',
      keepPinned: true,
    })
    expect(keep.items.map((i) => i.id)).toEqual(['t1'])
    expect(skipCount(keep, 'pinned')).toBe(1)
    expect(skipCount(keep, 'active')).toBe(1)

    const everything = planBulk({
      snapshot: snapshot(),
      kinds: new Set<BulkKind>(['thread']),
      action: 'delete',
      keepPinned: false,
    })
    expect(everything.items.map((i) => i.id)).toEqual(['t1', 't2'])
    // A running chat is never touched, even with keep-pinned off.
    expect(skipCount(everything, 'active')).toBe(1)
  })

  it('leaves unticked kinds out of both lists', () => {
    const plan = planBulk({
      snapshot: snapshot(),
      kinds: new Set<BulkKind>(['room']),
      action: 'delete',
      keepPinned: true,
    })
    expect(plan.items.map((i) => i.id)).toEqual(['r1'])
    expect(plan.skipped).toEqual([])
  })

  it('cannot archive campaigns, which have no archive', () => {
    const plan = planBulk({
      snapshot: snapshot(),
      kinds: all,
      action: 'archive',
      keepPinned: true,
    })
    expect(plan.items.some((i) => i.kind === 'campaign')).toBe(false)
    expect(skipCount(plan, 'unsupported')).toBe(2)
    expect(planCounts(plan)).toEqual({ thread: 1, cowork: 1, room: 1, campaign: 0 })
  })

  it('deletes idle campaigns and skips running ones', () => {
    const plan = planBulk({
      snapshot: snapshot(),
      kinds: new Set<BulkKind>(['campaign']),
      action: 'delete',
      keepPinned: true,
    })
    expect(plan.items.map((i) => i.id)).toEqual(['k1'])
    expect(skipCount(plan, 'active')).toBe(1)
  })
})

describe('runBulk', () => {
  const plan = () =>
    planBulk({
      snapshot: snapshot(),
      kinds: new Set<BulkKind>(['thread', 'room']),
      action: 'delete',
      keepPinned: false,
    })
  const noYield = () => Promise.resolve()

  it('runs every item and reports progress', async () => {
    const act = vi.fn().mockResolvedValue(undefined)
    const onProgress = vi.fn()
    const report = await runBulk(plan(), act, { onProgress, yieldFn: noYield })
    expect(act).toHaveBeenCalledTimes(3)
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), 'delete')
    expect(report.results.every((r) => r.ok)).toBe(true)
    expect(report.stopped).toBe(false)
    expect(onProgress).toHaveBeenLastCalledWith({ done: 3, total: 3 })
  })

  it('records a failure per item and keeps going', async () => {
    const act = vi.fn(async (i: BulkItem) => {
      if (i.id === 't2') throw new Error('disk full')
      if (i.id === 'r1') throw new BulkKept('unmerged work')
    })
    const report = await runBulk(plan(), act, { yieldFn: noYield })
    expect(report.results.map((r) => r.ok)).toEqual([true, false, false])
    expect(report.results[1].error).toBe('disk full')
    expect(report.results[2]).toMatchObject({ kept: true, error: 'unmerged work' })
  })

  it('stops before the next item when aborted and lists what was left', async () => {
    const ctl = new AbortController()
    const act = vi.fn(async (i: BulkItem) => {
      if (i.id === 't1') ctl.abort()
    })
    const report = await runBulk(plan(), act, { signal: ctl.signal, yieldFn: noYield })
    expect(act).toHaveBeenCalledTimes(1)
    expect(report.stopped).toBe(true)
    expect(report.untouched.map((i) => i.id)).toEqual(['t2', 'r1'])
  })

  it('yields to the UI between items', async () => {
    const yieldFn = vi.fn(() => Promise.resolve())
    await runBulk(plan(), async () => undefined, { yieldFn })
    expect(yieldFn).toHaveBeenCalledTimes(3)
  })
})
