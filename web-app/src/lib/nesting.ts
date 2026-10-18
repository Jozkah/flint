/**
 * Nesting for the sidebar's lists: a chat or session whose recorded parent
 * (the chat it was forked from, the session it was forked from) is in the same
 * list is shown under that parent instead of as a row of its own.
 *
 * Display only. Nothing here changes stored data: a parent that is deleted,
 * filtered out or moved to another group simply leaves its children as
 * ordinary rows (an orphan is a root), so deleting a parent never deletes or
 * hides a child.
 *
 * Two levels are drawn: the root and its nested rows. A grandchild is listed
 * with its root's nested rows (flattened, newest first), never deeper.
 */

/** The state a nested row's mark shows; the same words as ThreadStatusMark. */
export type NestStatus = 'wait' | 'active' | 'recent' | 'none'

export type NestRoot = {
  id: string
  /** Every descendant in this list, newest first. */
  nested: string[]
}

export type NestItem = {
  id: string
  /** The recorded parent's id; absent or unknown means a root. */
  parentId?: string | null
  /** For ordering nested rows; larger is newer. */
  updated?: number
}

/**
 * Builds the two-level tree from a flat list.
 *
 * Roots keep the input order (the list's own sort: pinned, recency, ...).
 * A link to an id that is not in the list, or to itself, is ignored. A cycle
 * (a -> b -> a, which stored data should never hold but must not hang on) is
 * broken at its newest member, which becomes the root.
 */
export function buildNestTree(items: readonly NestItem[]): NestRoot[] {
  const byId = new Map<string, NestItem>()
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item)
  const order = new Map<string, number>()
  items.forEach((item, i) => {
    if (!order.has(item.id)) order.set(item.id, i)
  })

  const parentOf = (id: string): string | null => {
    const p = byId.get(id)?.parentId
    return p && p !== id && byId.has(p) ? p : null
  }
  const newer = (a: string, b: string) => {
    const ua = byId.get(a)?.updated ?? 0
    const ub = byId.get(b)?.updated ?? 0
    if (ua !== ub) return ub - ua
    return (order.get(a) ?? 0) - (order.get(b) ?? 0)
  }

  // Members of a cycle that are cut loose: the newest of each cycle.
  const cut = new Set<string>()
  const settled = new Set<string>()
  for (const id of byId.keys()) {
    const path: string[] = []
    const onPath = new Set<string>()
    let cur: string | null = id
    while (cur && !settled.has(cur) && !onPath.has(cur)) {
      path.push(cur)
      onPath.add(cur)
      cur = cut.has(cur) ? null : parentOf(cur)
    }
    if (cur && onPath.has(cur)) {
      const cycle = path.slice(path.indexOf(cur))
      cut.add([...cycle].sort(newer)[0])
    }
    for (const p of path) settled.add(p)
  }

  const rootOf = new Map<string, string>()
  const findRoot = (id: string): string => {
    const known = rootOf.get(id)
    if (known) return known
    const chain: string[] = []
    let cur = id
    for (;;) {
      chain.push(cur)
      const p = cut.has(cur) ? null : parentOf(cur)
      if (!p) break
      const r = rootOf.get(p)
      if (r) {
        cur = r
        break
      }
      cur = p
    }
    for (const c of chain) rootOf.set(c, cur)
    return cur
  }

  const nested = new Map<string, string[]>()
  const roots: string[] = []
  for (const id of byId.keys()) {
    const r = findRoot(id)
    if (r === id) roots.push(id)
    else nested.set(r, [...(nested.get(r) ?? []), id])
  }
  return roots.map((id) => ({
    id,
    nested: [...(nested.get(id) ?? [])].sort(newer),
  }))
}

/** Nested rows shown before the rest fold into one summary row. */
export const NEST_LIMIT = 3

/**
 * Which nested rows show. Expanded: all of them. Folded: the first
 * `limit`, plus any row that must stay in view (the open one, one that is
 * working or waiting), which is then left out of the summary.
 */
export function splitNested(
  nested: readonly string[],
  opts: {
    expanded: boolean
    sticky: (id: string) => boolean
    limit?: number
  }
): { shown: string[]; hidden: string[] } {
  const limit = opts.limit ?? NEST_LIMIT
  if (opts.expanded || nested.length <= limit)
    return { shown: [...nested], hidden: [] }
  const shown: string[] = []
  const hidden: string[] = []
  nested.forEach((id, i) => {
    if (i < limit || opts.sticky(id)) shown.push(id)
    else hidden.push(id)
  })
  return { shown, hidden }
}

export type NestCounts = {
  total: number
  /** Finished within the last hour and not yet looked at. */
  fresh: number
  working: number
  waiting: number
}

/** What the summary row says about the rows it hides. */
export function countNested(
  ids: readonly string[],
  statusOf: (id: string) => NestStatus
): NestCounts {
  const counts: NestCounts = { total: ids.length, fresh: 0, working: 0, waiting: 0 }
  for (const id of ids) {
    const s = statusOf(id)
    if (s === 'wait') counts.waiting++
    else if (s === 'active') counts.working++
    else if (s === 'recent') counts.fresh++
  }
  return counts
}

/** A nested row that must never fold away. */
export function isStickyStatus(status: NestStatus, selected: boolean): boolean {
  return selected || status === 'wait' || status === 'active'
}
