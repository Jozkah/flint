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
// Status -> dot and group
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

/**
 * The four plain groups the board shows, in the order a person needs them:
 * what waits on them first, then what is moving, what is next, what is over.
 */
export type TaskGroup = 'needs-you' | 'working' | 'up-next' | 'done'

export const TASK_GROUPS: readonly TaskGroup[] = [
  'needs-you',
  'working',
  'up-next',
  'done',
]

export function groupOf(
  task: Pick<CampaignTask, 'status' | 'dependsOn'>,
  all: readonly Pick<CampaignTask, 'id' | 'status'>[] = []
): TaskGroup {
  switch (dotOf(task, all)) {
    case 'needs-you':
    case 'failed':
    case 'conflict':
      return 'needs-you'
    case 'running':
    case 'verifying':
    case 'verified':
      return 'working'
    case 'queued':
    case 'blocked':
      return 'up-next'
    case 'merged':
    case 'cancelled':
      return 'done'
  }
}

/** Only the groups that hold something, in order, tasks in plan order. */
export function groupTasks(
  tasks: readonly CampaignTask[]
): { group: TaskGroup; tasks: CampaignTask[] }[] {
  const by = new Map<TaskGroup, CampaignTask[]>()
  for (const t of tasks) {
    const g = groupOf(t, tasks)
    by.set(g, [...(by.get(g) ?? []), t])
  }
  return TASK_GROUPS.filter((g) => by.has(g)).map((g) => ({
    group: g,
    tasks: by.get(g)!,
  }))
}

/** One plain phrase for a task's state (the key is under `board.word`). */
export type TaskWord =
  | 'writing'
  | 'checking'
  | 'ready'
  | 'needsInput'
  | 'needsApproval'
  | 'failed'
  | 'conflict'
  | 'waiting'
  | 'queued'
  | 'merged'
  | 'skipped'

export function wordOf(
  task: Pick<CampaignTask, 'status' | 'dependsOn'>,
  all: readonly Pick<CampaignTask, 'id' | 'status' | 'title'>[] = []
): { word: TaskWord; waitingFor: string[] } {
  const waitingFor = task.dependsOn
    .map((d) => all.find((t) => t.id === d))
    .filter((t) => t && t.status !== 'merged')
    .map((t) => t!.title)
  const only = (word: TaskWord) => ({ word, waitingFor: [] as string[] })
  switch (task.status) {
    case 'pending':
    case 'blocked':
      return waitingFor.length > 0
        ? { word: 'waiting', waitingFor }
        : only('queued')
    case 'queued':
    case 'interrupted':
      return only('queued')
    case 'running':
      return only('writing')
    case 'awaiting_input':
      return only('needsInput')
    case 'awaiting_approval':
      return only('needsApproval')
    case 'completed':
    case 'verifying':
      return only('checking')
    case 'verified':
      return only('ready')
    case 'merged':
      return only('merged')
    case 'failed':
      return only('failed')
    case 'conflict':
      return only('conflict')
    case 'cancelled':
      return only('skipped')
  }
}

// ---------------------------------------------------------------------------
// Headline and the one primary button
// ---------------------------------------------------------------------------

export type HeadlineKey =
  | 'planning'
  | 'working'
  | 'attention'
  | 'review'
  | 'merging'
  | 'paused'
  | 'interrupted'
  | 'done'
  | 'failed'
  | 'cancelled'

export type Headline = {
  key: HeadlineKey
  /** Tasks being worked on, or needing the person, depending on the key. */
  count: number
  done: number
  total: number
}

/** The campaign in one line a person can read without knowing the states. */
export function headlineOf(c: Pick<Campaign, 'status' | 'tasks'>): Headline {
  const total = c.tasks.length
  const done = c.tasks.filter((t) => t.status === 'merged').length
  const groups = groupTasks(c.tasks)
  const countIn = (g: TaskGroup) =>
    groups.find((x) => x.group === g)?.tasks.length ?? 0
  const make = (key: HeadlineKey, count = 0): Headline => ({
    key,
    count,
    done,
    total,
  })
  switch (c.status) {
    case 'done':
      return make('done')
    case 'failed':
      return make('failed')
    case 'cancelled':
      return make('cancelled')
    case 'paused':
      return make('paused')
    case 'interrupted':
      return make('interrupted')
    case 'reviewing':
      return make('review')
    case 'merging':
      return make('merging')
    default:
      break
  }
  if (total === 0) return make('planning')
  const needs = countIn('needs-you')
  if (needs > 0) return make('attention', needs)
  return make('working', countIn('working') + countIn('up-next'))
}

export type PrimaryAction = 'pause' | 'resume' | 'review' | 'coordinator'

/** The single button the header leads with, matched to the campaign's state. */
export function primaryActionOf(
  c: Pick<Campaign, 'status' | 'tasks'>
): PrimaryAction {
  switch (c.status) {
    case 'running':
    case 'approved':
      // When something needs the person, the place to answer is the session
      // that is asking; pausing is a secondary choice then.
      return groupTasks(c.tasks).some((g) => g.group === 'needs-you')
        ? 'coordinator'
        : 'pause'
    case 'paused':
    case 'interrupted':
      return 'resume'
    case 'reviewing':
      return 'review'
    default:
      return 'coordinator'
  }
}

/** Whether the campaign can still be cancelled. */
export const canCancel = (status: CampaignStatus): boolean =>
  !['done', 'failed', 'cancelled'].includes(status)

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
  /** Over for good: the sidebar folds it to one line. */
  finished: boolean
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

const FINISHED: ReadonlySet<CampaignStatus> = new Set([
  'done',
  'failed',
  'cancelled',
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
    // A session that carries this campaign's link but is no task's current
    // session (the old session of a retried task) belongs here too, so it is
    // never listed anywhere else.
    for (const ref of sessions) {
      const link = ref.campaign
      if (!link || link.id !== c.id) continue
      const owner = c.tasks.find((t) => t.id === link.taskId)
      take({
        sessionId: ref.id,
        role: link.role,
        ...(link.taskId ? { taskId: link.taskId } : {}),
        ...(link.role === 'task'
          ? {
              dot: owner
                ? dotOf(owner, c.tasks)
                : ('cancelled' as CampaignDot),
            }
          : {}),
      })
    }
    if (rows.length === 0) continue
    groups.push({
      campaignId: c.id,
      title: c.title,
      status: c.status,
      done: c.tasks.filter((t) => t.status === 'merged').length,
      total: c.tasks.length,
      finished: FINISHED.has(c.status),
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
