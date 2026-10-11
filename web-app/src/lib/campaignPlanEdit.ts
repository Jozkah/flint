/**
 * Editing a campaign plan before it is approved (docs/CAMPAIGNS.md).
 *
 * Pure helpers for the plan card's editor: the edits (add, remove, reorder,
 * change a field, set dependencies), the same validation the backend runs
 * (`campaign::validate_plan`, so the card says why before Save is pressed),
 * and the estimate the plan result carries. The backend validates again on
 * save; this only makes the reason visible early.
 */
import { campaignApi } from '@/lib/campaignApi'
import { CAMPAIGN_MAX_TASKS, type Campaign, type PlanTask } from '@/lib/campaignModel'

export type PlanIssue =
  | { code: 'noTasks' }
  | { code: 'tooMany'; count: number; max: number }
  | { code: 'emptyTitle'; task: string }
  | { code: 'emptyBrief'; task: string }
  | { code: 'badPath'; task: string; path: string }
  | { code: 'selfDependency'; task: string }
  | { code: 'unknownDependency'; task: string; dep: string }
  | { code: 'cycle'; tasks: string[] }
  | { code: 'overlap'; a: string; b: string; path: string }

const normalizePath = (raw: string): string | null => {
  const s = raw.trim().replace(/\\/g, '/')
  if (!s || s.startsWith('/') || s.includes(':')) return null
  const parts: string[] = []
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return null
    parts.push(seg.toLowerCase())
  }
  return parts.join('/')
}

const covers = (outer: string, inner: string) =>
  outer === '' || inner === outer || inner.startsWith(`${outer}/`)

function findCycle(tasks: readonly PlanTask[]): string[] | null {
  const deps = new Map(
    tasks.map((t) => [t.id, (t.dependsOn ?? []).filter((d) => d !== t.id)])
  )
  const mark = new Map<string, 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    const m = mark.get(id)
    if (m === 2) return null
    if (m === 1) {
      return [...stack.slice(Math.max(0, stack.indexOf(id))), id]
    }
    mark.set(id, 1)
    stack.push(id)
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue
      const c = visit(d)
      if (c) return c
    }
    stack.pop()
    mark.set(id, 2)
    return null
  }
  for (const id of [...deps.keys()].sort()) {
    const c = visit(id)
    if (c) return c
  }
  return null
}

/** Why a plan cannot run, in a stable order; empty when it can. */
export function validatePlan(tasks: readonly PlanTask[]): PlanIssue[] {
  const issues: PlanIssue[] = []
  if (tasks.length === 0) issues.push({ code: 'noTasks' })
  if (tasks.length > CAMPAIGN_MAX_TASKS) {
    issues.push({
      code: 'tooMany',
      count: tasks.length,
      max: CAMPAIGN_MAX_TASKS,
    })
  }
  const ids = new Set(tasks.map((t) => t.id))
  for (const t of tasks) {
    if (!t.title.trim()) issues.push({ code: 'emptyTitle', task: t.id })
    if (!t.brief.trim()) issues.push({ code: 'emptyBrief', task: t.id })
    for (const p of t.paths ?? []) {
      if (normalizePath(p) === null) {
        issues.push({ code: 'badPath', task: t.id, path: p })
      }
    }
  }
  for (const t of tasks) {
    for (const d of t.dependsOn ?? []) {
      if (d === t.id) issues.push({ code: 'selfDependency', task: t.id })
      else if (!ids.has(d)) {
        issues.push({ code: 'unknownDependency', task: t.id, dep: d })
      }
    }
  }
  const cycle = findCycle(tasks)
  if (cycle) issues.push({ code: 'cycle', tasks: cycle })
  if (issues.length === 0) issues.push(...parallelOverlaps(tasks))
  return issues
}

function parallelOverlaps(tasks: readonly PlanTask[]): PlanIssue[] {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn ?? []]))
  const ancestors = (id: string): Set<string> => {
    const seen = new Set<string>()
    const todo = [id]
    while (todo.length > 0) {
      const cur = todo.pop()!
      for (const d of deps.get(cur) ?? []) {
        if (!seen.has(d)) {
          seen.add(d)
          todo.push(d)
        }
      }
    }
    return seen
  }
  const out: PlanIssue[] = []
  tasks.forEach((a, i) => {
    const aAnc = ancestors(a.id)
    for (const b of tasks.slice(i + 1)) {
      if (aAnc.has(b.id) || ancestors(b.id).has(a.id)) continue
      const pas = (a.paths ?? []).map(normalizePath).filter((p): p is string => p !== null)
      const pbs = (b.paths ?? []).map(normalizePath).filter((p): p is string => p !== null)
      const hit = pas
        .flatMap((pa) => pbs.map((pb) => [pa, pb] as const))
        .find(([pa, pb]) => covers(pa, pb) || covers(pb, pa))
      if (hit) {
        out.push({
          code: 'overlap',
          a: a.id,
          b: b.id,
          path: hit[0] === '' ? '.' : hit[0],
        })
      }
    }
  })
  return out
}

// ---------------------------------------------------------------------------
// Edits (all return new arrays; the inputs are never changed)
// ---------------------------------------------------------------------------

/** A task id not used yet: `t1`, `t2`, and so on. */
export function nextTaskId(tasks: readonly PlanTask[]): string {
  const used = new Set(tasks.map((t) => t.id))
  let n = tasks.length + 1
  while (used.has(`t${n}`)) n += 1
  return `t${n}`
}

export function addTask(tasks: readonly PlanTask[]): PlanTask[] {
  return [
    ...tasks,
    {
      id: nextTaskId(tasks),
      title: '',
      brief: '',
      acceptance: [],
      paths: [],
      dependsOn: [],
    },
  ]
}

/** Removes a task and every dependency that pointed at it. */
export function removeTask(tasks: readonly PlanTask[], id: string): PlanTask[] {
  return tasks
    .filter((t) => t.id !== id)
    .map((t) =>
      (t.dependsOn ?? []).includes(id)
        ? { ...t, dependsOn: (t.dependsOn ?? []).filter((d) => d !== id) }
        : t
    )
}

export function moveTask(
  tasks: readonly PlanTask[],
  id: string,
  by: -1 | 1
): PlanTask[] {
  const from = tasks.findIndex((t) => t.id === id)
  const to = from + by
  if (from < 0 || to < 0 || to >= tasks.length) return [...tasks]
  const next = [...tasks]
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

export function patchTask(
  tasks: readonly PlanTask[],
  id: string,
  patch: Partial<Omit<PlanTask, 'id'>>
): PlanTask[] {
  return tasks.map((t) => (t.id === id ? { ...t, ...patch } : t))
}

/** One list per line, blanks dropped: how paths and acceptance are typed. */
export const linesOf = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

/** True when two plans would be saved as different records. */
export function planChanged(
  a: readonly PlanTask[],
  b: readonly PlanTask[]
): boolean {
  const key = (ts: readonly PlanTask[]) =>
    JSON.stringify(
      ts.map((t) => [
        t.id,
        t.title,
        t.brief,
        t.acceptance ?? [],
        t.paths ?? [],
        t.dependsOn ?? [],
        t.kind ?? '',
      ])
    )
  return key(a) !== key(b)
}

/** The campaign's tasks as plan tasks (what the editor starts from). */
export const planTasksOf = (c: Pick<Campaign, 'tasks'>): PlanTask[] =>
  c.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    brief: t.brief,
    acceptance: [...t.acceptance],
    paths: [...t.paths],
    dependsOn: [...t.dependsOn],
    ...(t.kind === 'check' ? { kind: 'check' as const } : {}),
  }))

/** Saves an edited plan while the campaign is still `planned`. */
export const campaignPlanApi = {
  update: (id: string, tasks: PlanTask[]) =>
    campaignApi.planUpdate(id, { ops: [{ op: 'replace', tasks }] }),
}

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

export type PlanEstimate = {
  low: number
  high: number
  /** What the figure depends on, in plain words. */
  basis: string[]
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null

/**
 * Reads the estimate the plan result carries. The field is optional and its
 * spelling is tolerated (`low`/`high`, `min`/`max`, `tokens_low`/`tokens_high`,
 * a plain `tokens`); anything unreadable hides the line.
 */
export function readEstimate(raw: unknown): PlanEstimate | null {
  if (raw == null) return null
  if (typeof raw === 'number') {
    const n = num(raw)
    return n === null ? null : { low: n, high: n, basis: [] }
  }
  if (typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const low = num(o.low ?? o.min ?? o.tokens_low ?? o.tokensLow ?? o.tokens)
  const high = num(o.high ?? o.max ?? o.tokens_high ?? o.tokensHigh ?? o.tokens)
  const samples = num(o.samples)
  if (low === null && high === null) return null
  const lo = Math.min(low ?? high!, high ?? low!)
  const hi = Math.max(low ?? high!, high ?? low!)
  const basisRaw = o.basis ?? o.depends_on ?? o.dependsOn ?? o.assumptions
  // The backend's `basis` is `history` or `default`, not a list of reasons.
  const basis =
    basisRaw === 'history'
      ? [`earlier campaigns (${samples ?? 0} tasks)`]
      : basisRaw === 'default'
        ? []
        : Array.isArray(basisRaw)
          ? basisRaw.filter(
              (x): x is string => typeof x === 'string' && x.trim() !== ''
            )
          : typeof basisRaw === 'string' && basisRaw.trim() !== ''
            ? [basisRaw]
            : []
  return { low: lo, high: hi, basis }
}
