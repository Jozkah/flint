/**
 * Campaigns: pure view logic for the sidebar group and the status board
 * (docs/CAMPAIGNS.md). Nothing here persists or calls the backend; the backend
 * record stays the truth and this only reads it.
 */
import type {
  Campaign,
  CampaignStatus,
  CampaignTask,
  CampaignTaskStatus,
} from '@/lib/campaignModel'
import type { CampaignLink } from '@/types/coworkSession'

// ---------------------------------------------------------------------------
// Status -> dot and column
// ---------------------------------------------------------------------------

export type CampaignDot =
  | 'queued'
  | 'blocked'
  | 'running'
  | 'needs-you'
  | 'verifying'
  | 'verified'
  | 'merged'
  | 'failed'
  | 'conflict'
  | 'cancelled'

export type BoardColumn =
  | 'blocked'
  | 'queued'
  | 'running'
  | 'needs-you'
  | 'verifying'
  | 'done'
  | 'failed'

export const BOARD_COLUMNS: readonly BoardColumn[] = [
  'blocked',
  'queued',
  'running',
  'needs-you',
  'verifying',
  'done',
  'failed',
]

/** A pending task whose dependencies are not all merged is waiting, not queued. */
export function isWaitingOnDeps(
  task: Pick<CampaignTask, 'status' | 'dependsOn'>,
  all: readonly Pick<CampaignTask, 'id' | 'status'>[]
): boolean {
  if (task.status !== 'pending') return false
  return task.dependsOn.some(
    (d) => all.find((t) => t.id === d)?.status !== 'merged'
  )
}

export function dotOf(
  task: Pick<CampaignTask, 'status' | 'dependsOn'>,
  all: readonly Pick<CampaignTask, 'id' | 'status'>[] = []
): CampaignDot {
  const s: CampaignTaskStatus = task.status
  switch (s) {
    case 'pending':
      return isWaitingOnDeps(task, all) ? 'blocked' : 'queued'
    case 'queued':
    case 'interrupted':
      return 'queued'
    case 'blocked':
      return 'blocked'
    case 'running':
      return 'running'
    case 'awaiting_input':
    case 'awaiting_approval':
      return 'needs-you'
    case 'completed':
    case 'verifying':
      return 'verifying'
    case 'verified':
      return 'verified'
    case 'merged':
      return 'merged'
    case 'failed':
      return 'failed'
    case 'conflict':
      return 'conflict'
    case 'cancelled':
      return 'cancelled'
  }
}

export function columnOf(
  task: Pick<CampaignTask, 'status' | 'dependsOn'>,
  all: readonly Pick<CampaignTask, 'id' | 'status'>[] = []
): BoardColumn {
  switch (dotOf(task, all)) {
    case 'blocked':
      return 'blocked'
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'needs-you':
      return 'needs-you'
    case 'verifying':
      return 'verifying'
    case 'verified':
    case 'merged':
      return 'done'
    case 'failed':
    case 'conflict':
    case 'cancelled':
      return 'failed'
  }
}

/** Tasks per column, in plan order. Every column is present. */
export function groupByColumn(
  tasks: readonly CampaignTask[]
): Record<BoardColumn, CampaignTask[]> {
  const out = Object.fromEntries(
    BOARD_COLUMNS.map((c) => [c, [] as CampaignTask[]])
  ) as Record<BoardColumn, CampaignTask[]>
  for (const t of tasks) out[columnOf(t, tasks)].push(t)
  return out
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export type BudgetView = {
  used: number
  budget: number | null
  /** 0 to 100, clamped; 0 when there is no budget. */
  percent: number
  level: 'ok' | 'warn' | 'over' | 'none'
}

/** Tokens used across tasks against the campaign budget; warns from 80 percent. */
export function budgetOf(c: Pick<Campaign, 'tasks' | 'limits'>): BudgetView {
  const used = c.tasks.reduce((n, t) => n + Math.max(0, t.tokensUsed || 0), 0)
  const budget = c.limits.tokenBudget ?? null
  if (budget == null || budget <= 0) {
    return { used, budget: null, percent: 0, level: 'none' }
  }
  const ratio = used / budget
  return {
    used,
    budget,
    percent: Math.min(100, Math.max(0, Math.round(ratio * 100))),
    level: ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok',
  }
}

// ---------------------------------------------------------------------------
// Sidebar group
// ---------------------------------------------------------------------------

export type CampaignGroupRow = {
  sessionId: string
  role: 'coordinator' | 'task'
  taskId?: string
  /** Absent for the coordinator. */
  dot?: CampaignDot
}

export type CampaignGroup = {
  campaignId: string
  title: string
  status: CampaignStatus
  done: number
  total: number
  rows: CampaignGroupRow[]
}

type SessionRef = { id: string; campaign?: CampaignLink }

/** Statuses whose group is kept at the top of the list. */
const ACTIVE: ReadonlySet<CampaignStatus> = new Set([
  'planned',
  'approved',
  'running',
  'paused',
  'reviewing',
  'merging',
  'interrupted',
])

/**
 * Derived, never persisted: one group per known campaign that still has a
 * session in the store. Sessions of a campaign the backend does not list (or
 * not yet loaded) are left out, so they keep their ordinary place. A session
 * appears in at most one group.
 */
export function deriveCampaignGroups(
  campaigns: readonly Campaign[],
  sessions: readonly SessionRef[]
): CampaignGroup[] {
  const present = new Set(sessions.map((s) => s.id))
  const claimed = new Set<string>()
  const groups: CampaignGroup[] = []
  for (const c of campaigns) {
    // A plan nobody approved (waiting, denied or cancelled before any task got
    // a session) is not a group: its coordinator keeps its ordinary place.
    const neverStarted =
      (c.status === 'planned' ||
        c.status === 'draft' ||
        c.status === 'cancelled') &&
      !c.tasks.some((t) => t.sessionId)
    if (neverStarted) continue
    const rows: CampaignGroupRow[] = []
    const take = (row: CampaignGroupRow) => {
      if (!present.has(row.sessionId) || claimed.has(row.sessionId)) return
      claimed.add(row.sessionId)
      rows.push(row)
    }
    take({ sessionId: c.coordinatorSession, role: 'coordinator' })
    for (const t of c.tasks) {
      if (!t.sessionId) continue
      take({
        sessionId: t.sessionId,
        role: 'task',
        taskId: t.id,
        dot: dotOf(t, c.tasks),
      })
    }
    if (rows.length === 0) continue
    groups.push({
      campaignId: c.id,
      title: c.title,
      status: c.status,
      done: c.tasks.filter((t) => t.status === 'merged').length,
      total: c.tasks.length,
      rows,
    })
  }
  // Active first, then as the backend listed them (stable).
  return groups
    .map((g, i) => ({ g, i }))
    .sort(
      (a, b) =>
        Number(ACTIVE.has(b.g.status)) - Number(ACTIVE.has(a.g.status)) ||
        a.i - b.i
    )
    .map((x) => x.g)
}

/** Session ids a derived group shows, so the ordinary tree can leave them out. */
export function claimedSessionIds(groups: readonly CampaignGroup[]): Set<string> {
  return new Set(groups.flatMap((g) => g.rows.map((r) => r.sessionId)))
}

// ---------------------------------------------------------------------------
// Task actions
// ---------------------------------------------------------------------------

const LIVE: ReadonlySet<CampaignTaskStatus> = new Set([
  'running',
  'awaiting_input',
  'awaiting_approval',
])

/** Mirrors `MAX_RETRIES` in the backend (campaign.rs). */
export const CAMPAIGN_MAX_RETRIES = 2

/** What the board offers for a task; the backend still enforces every edge. */
export function taskActionsOf(
  task: Pick<CampaignTask, 'status' | 'sessionId' | 'attempt'>
): {
  open: boolean
  note: boolean
  stop: boolean
  retry: boolean
  skip: boolean
  handoff: boolean
} {
  const s = task.status
  const hasSession = !!task.sessionId
  return {
    open: hasSession,
    note: hasSession && LIVE.has(s),
    stop: LIVE.has(s) || s === 'queued' || s === 'blocked' || s === 'pending',
    retry:
      (s === 'failed' || s === 'conflict') && task.attempt < CAMPAIGN_MAX_RETRIES,
    // The same set campaign_merge skip accepts.
    skip: ['failed', 'conflict', 'completed', 'blocked', 'interrupted'].includes(s),
    handoff: !['pending', 'blocked', 'queued'].includes(s),
  }
}

/** Distinct files a session changed, from its recorded tool activity. */
export function changedFilesOf(
  events: readonly { path: string; ok: boolean; operation: string }[] | undefined
): string[] {
  const changing = new Set(['create', 'write', 'edit', 'delete', 'rename'])
  const seen = new Set<string>()
  for (const e of events ?? []) {
    if (e.ok && changing.has(e.operation)) seen.add(e.path)
  }
  return [...seen].sort()
}
