/**
 * Bulk archive / delete of conversations: chats, Cowork sessions, rooms and
 * campaigns. Pure planning, counting and a cancellable runner; the real
 * per-item actions live in `bulkConversationsDeps.ts` so this stays testable.
 */

export type BulkKind = 'thread' | 'cowork' | 'room' | 'campaign'
export type BulkAction = 'archive' | 'delete'

export const BULK_KINDS: readonly BulkKind[] = ['thread', 'cowork', 'room', 'campaign']

/** Kinds the Archive can hold. A campaign has no archive, only delete. */
export const ARCHIVABLE: Readonly<Record<BulkKind, boolean>> = {
  thread: true,
  cowork: true,
  room: true,
  campaign: false,
}

export type BulkItem = {
  kind: BulkKind
  id: string
  title: string
  /** A pinned (favorite) chat: skipped when "keep pinned" is on. */
  pinned?: boolean
  /** Something is running on it: always skipped, never stopped. */
  active?: boolean
}

export type BulkSnapshot = Record<BulkKind, BulkItem[]>

export type SkipReason = 'pinned' | 'active' | 'unsupported'

export type BulkPlan = {
  action: BulkAction
  /** What will be processed, in kind order. */
  items: BulkItem[]
  skipped: { item: BulkItem; reason: SkipReason }[]
}

export type KindCounts = { total: number; pinned: number; active: number }

export const emptySnapshot = (): BulkSnapshot => ({
  thread: [],
  cowork: [],
  room: [],
  campaign: [],
})

/** Per-kind totals shown beside each checkbox. */
export function countKinds(snapshot: BulkSnapshot): Record<BulkKind, KindCounts> {
  const out = {} as Record<BulkKind, KindCounts>
  for (const kind of BULK_KINDS) {
    const list = snapshot[kind]
    out[kind] = {
      total: list.length,
      pinned: list.filter((i) => i.pinned).length,
      active: list.filter((i) => i.active).length,
    }
  }
  return out
}

/**
 * Decide what a bulk run would touch. Unselected kinds are left out of both
 * lists. A running item is always skipped; a pinned one only when `keepPinned`.
 * Archiving a kind with no archive skips all of it.
 */
export function planBulk(input: {
  snapshot: BulkSnapshot
  kinds: ReadonlySet<BulkKind>
  action: BulkAction
  keepPinned: boolean
}): BulkPlan {
  const items: BulkItem[] = []
  const skipped: BulkPlan['skipped'] = []
  for (const kind of BULK_KINDS) {
    if (!input.kinds.has(kind)) continue
    for (const item of input.snapshot[kind]) {
      if (input.action === 'archive' && !ARCHIVABLE[kind]) {
        skipped.push({ item, reason: 'unsupported' })
      } else if (item.active) {
        skipped.push({ item, reason: 'active' })
      } else if (item.pinned && input.keepPinned) {
        skipped.push({ item, reason: 'pinned' })
      } else {
        items.push(item)
      }
    }
  }
  return { action: input.action, items, skipped }
}

/** How many items of each kind a plan will process. */
export function planCounts(plan: BulkPlan): Record<BulkKind, number> {
  const out: Record<BulkKind, number> = { thread: 0, cowork: 0, room: 0, campaign: 0 }
  for (const i of plan.items) out[i.kind]++
  return out
}

export function skipCount(plan: BulkPlan, reason: SkipReason): number {
  return plan.skipped.filter((s) => s.reason === reason).length
}

export type BulkResult = {
  item: BulkItem
  ok: boolean
  /** Set on a failure, or on a partial outcome (e.g. kept in the Archive). */
  error?: string
  /** The delete stopped halfway: the item is safe in the Archive, not gone. */
  kept?: boolean
}

/**
 * Thrown by an action that archived the item but could not destroy it (a
 * Cowork session whose worktree holds unmerged work). The item is not lost.
 */
export class BulkKept extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'BulkKept'
  }
}

export type BulkProgress = { done: number; total: number; current?: BulkItem }

export type BulkReport = {
  results: BulkResult[]
  /** Items never reached because the run was stopped. */
  untouched: BulkItem[]
  stopped: boolean
}

export type BulkRunOptions = {
  signal?: AbortSignal
  onProgress?: (p: BulkProgress) => void
  /** Yield to the UI after this many items (default 1). */
  yieldEvery?: number
  /** Replaceable in tests. */
  yieldFn?: () => Promise<void>
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Run a plan one item at a time, so one failure never stops the rest and the
 * UI keeps painting between items. Stopping (the signal) takes effect before
 * the next item; the item in flight finishes.
 */
export async function runBulk(
  plan: BulkPlan,
  act: (item: BulkItem, action: BulkAction) => Promise<void>,
  opts: BulkRunOptions = {}
): Promise<BulkReport> {
  const results: BulkResult[] = []
  const every = Math.max(1, opts.yieldEvery ?? 1)
  const wait = opts.yieldFn ?? tick
  const total = plan.items.length
  let index = 0
  for (; index < total; index++) {
    if (opts.signal?.aborted) break
    const item = plan.items[index]
    opts.onProgress?.({ done: index, total, current: item })
    try {
      await act(item, plan.action)
      results.push({ item, ok: true })
    } catch (e) {
      results.push({
        item,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        ...(e instanceof BulkKept ? { kept: true } : {}),
      })
    }
    if ((index + 1) % every === 0) await wait()
  }
  opts.onProgress?.({ done: results.length, total })
  return {
    results,
    untouched: plan.items.slice(index),
    stopped: index < total,
  }
}
