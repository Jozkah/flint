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
  /** Coordinator only: the plan is being drawn up. */
  | 'planning'
  /** Coordinator only: every task is in and the result waits for review. */
  | 'review'

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

/**
 * The skipped (cancelled) tasks a not yet started task is waiting for. Such a
 * task never starts by itself: a skipped dependency is not a merged one, so
 * it needs a person to skip it too or to run it without that dependency.
 */
export function skippedDepsOf<
  T extends Pick<CampaignTask, 'id' | 'status' | 'title'>,
>(
  task: Pick<CampaignTask, 'status' | 'dependsOn'>,
  all: readonly T[]
): T[] {
  if (task.status !== 'pending' && task.status !== 'blocked') return []
  return task.dependsOn
    .map((d) => all.find((t) => t.id === d))
    .filter((t): t is T => !!t && t.status === 'cancelled')
}

const CLOSED: ReadonlySet<CampaignTaskStatus> = new Set(['merged', 'cancelled'])

/**
 * The tasks that wait, directly or through another task, on `taskId` and are
 * not over yet: what skipping it holds up or would take with it.
 */
export function dependantsOf<
  T extends Pick<CampaignTask, 'id' | 'status' | 'dependsOn'>,
>(taskId: string, all: readonly T[]): T[] {
  const reached = new Set<string>([taskId])
  const out: T[] = []
  for (let grew = true; grew; ) {
    grew = false
    for (const t of all) {
      if (reached.has(t.id) || CLOSED.has(t.status)) continue
      if (t.dependsOn.some((d) => reached.has(d))) {
        reached.add(t.id)
        out.push(t)
        grew = true
      }
    }
  }
  return out
}

/** Tasks merged and tasks skipped, counted apart (a skipped task is not done). */
export function taskCounts(tasks: readonly Pick<CampaignTask, 'status'>[]): {
  merged: number
  skipped: number
  total: number
} {
  return {
    merged: tasks.filter((t) => t.status === 'merged').length,
    skipped: tasks.filter((t) => t.status === 'cancelled').length,
    total: tasks.length,
  }
}

/**
 * Nothing is left to run: every task is merged or skipped and at least one
 * merged. The campaign is then finished work, whatever the record's status
 * says in the moment before the backend moves it on.
 */
export function allTasksSettled(
  c: Pick<Campaign, 'tasks'>
): boolean {
  return (
    c.tasks.length > 0 &&
    c.tasks.every((t) => CLOSED.has(t.status)) &&
    c.tasks.some((t) => t.status === 'merged')
  )
}

/** The final build and test check ran and failed. */
export function gateFailedOf(c: object): boolean {
  const o = c as { gateFailed?: unknown; gate?: unknown }
  if (typeof o.gateFailed === 'boolean') return o.gateFailed
  const g = o.gate as { passed?: unknown; skipped?: unknown } | null | undefined
  return !!g && g.passed === false && g.skipped !== true
}

/** The automatic conflict resolver is working on the task. */
export function isResolving(task: { status: string }): boolean {
  return task.status === 'resolving'
}

/**
 * The files a task is in conflict on: the backend's list when the record
 * carries one (`conflictFiles`), otherwise the paths named in the detail text.
 */
export function conflictFilesOf(task: {
  detail?: string
  conflictFiles?: unknown
  resolver?: { files?: unknown } | null
}): string[] {
  const listed = task.conflictFiles ?? task.resolver?.files
  if (Array.isArray(listed)) {
    return listed.filter((f): f is string => typeof f === 'string' && f !== '')
  }
  const detail = task.detail ?? ''
  const at = detail.indexOf(':')
  if (!/conflict/i.test(detail) || at < 0) return []
  return [
    ...new Set(
      detail
        .slice(at + 1)
        .split(/[\n,;]+/)
        .map((x) => x.trim().replace(/^[-*]\s*/, ''))
        .filter((x) => x !== '' && !/\s/.test(x) && /[./]/.test(x))
    ),
  ]
}

/** The objective check (tests) a task's verification ran, when recorded. */
export type TaskCheck = {
  passed: boolean | null
  /** The last lines of the output, for a failed check. */
  tail: string
  /** Tokens the verifier spent, when recorded. */
  tokens: number | null
}

/**
 * Reads the check result off a task record: `check` ({passed, tail|output,
 * tokens}) and `verifyTokens`, whichever the backend wrote. Null when the
 * task carries neither.
 */
export function taskCheckOf(task: object): TaskCheck | null {
  const o = task as Record<string, unknown>
  const evidence = o.evidence as { check?: Record<string, unknown> } | null | undefined
  const raw = (evidence?.check ?? o.check) as Record<string, unknown> | undefined
  const num = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
  const spent = num(o.verifyTokens ?? o.verificationTokens ?? raw?.tokens)
  const tokens = spent !== null && spent > 0 ? spent : null
  if (!raw || typeof raw !== 'object') {
    return tokens === null ? null : { passed: null, tail: '', tokens }
  }
  const text = String(raw.tail ?? raw.output ?? '')
  const lines = text.trim().split(/\r?\n/)
  return {
    passed: typeof raw.passed === 'boolean' ? raw.passed : null,
    tail: lines.slice(-12).join('\n').slice(-1200),
    tokens,
  }
}

/** What a split-pane tab shows, one mark only. */
export type PaneMark = 'approval' | 'running' | 'done' | 'error' | 'none'

/**
 * One mark per pane tab. A question for the person outranks activity; a
 * finished mark is only for a campaign task that verified or merged, or a
 * Cowork run that ended normally; an error mark is for a task that failed or
 * conflicted and a run that ended in an error. An idle conversation that
 * merely has content shows nothing.
 */
export function paneMarkOf(input: {
  needsApproval: boolean
  streaming: boolean
  task?: Pick<CampaignTask, 'status'> & Partial<Pick<CampaignTask, 'verdict'>>
  /** How the session's last Cowork run ended, when it is one. */
  ending?: { stoppedBy?: string | null } | null
}): PaneMark {
  if (input.needsApproval) return 'approval'
  if (input.streaming) return 'running'
  const task = input.task
  if (task) {
    if (task.status === 'merged' || task.status === 'verified') return 'done'
    if (task.status === 'completed' && task.verdict === 'PASS') return 'done'
    if (
      task.status === 'failed' ||
      task.status === 'conflict' ||
      (task.status === 'completed' && task.verdict === 'FAIL')
    ) {
      return 'error'
    }
    return 'none'
  }
  if (input.ending?.stoppedBy === 'done') return 'done'
  if (input.ending?.stoppedBy === 'error') return 'error'
  return 'none'
}

/**
 * A finished task whose verification could not decide: the verifier said
 * BLOCKED (or could not run), so it will not merge and nothing that depends
 * on it can start. It is a person's call, not something still being checked.
 */
export function isVerificationBlocked(
  task: Pick<CampaignTask, 'status'> & Partial<Pick<CampaignTask, 'verdict'>>
): boolean {
  return task.status === 'completed' && task.verdict === 'BLOCKED'
}

export function dotOf(
  task: Pick<CampaignTask, 'status' | 'dependsOn'> &
    Partial<Pick<CampaignTask, 'verdict'>>,
  all: readonly Pick<CampaignTask, 'id' | 'status'>[] = []
): CampaignDot {
  const s: CampaignTaskStatus = task.status
  // The conflict resolver is working on it (backend status `resolving`).
  if (isResolving(task)) return 'verifying'
  switch (s) {
    case 'pending':
      if (skippedDepsOf(task, all as never).length > 0) return 'needs-you'
      return isWaitingOnDeps(task, all) ? 'blocked' : 'queued'
    case 'queued':
    case 'interrupted':
      return 'queued'
    case 'blocked':
      return skippedDepsOf(task, all as never).length > 0 ? 'needs-you' : 'blocked'
    case 'running':
      return 'running'
    case 'awaiting_input':
    case 'awaiting_approval':
      return 'needs-you'
    case 'completed':
      return isVerificationBlocked(task) ? 'needs-you' : 'verifying'
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
    case 'resolving':
      return 'verifying'
    case 'cancelled':
      return 'cancelled'
  }
}

/**
 * The coordinator's own dot: the campaign's state in one mark (planning,
 * working, needs you, ready for review, done), so the coordinator row is not
 * the one row of the group without a signal.
 */
export function coordinatorDotOf(
  c: Pick<Campaign, 'status' | 'tasks'>
): CampaignDot {
  switch (c.status) {
    case 'done':
      return 'merged'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'reviewing':
      return 'review'
    case 'merging':
      return 'verifying'
    case 'paused':
    case 'interrupted':
      return 'queued'
    default:
      break
  }
  if (c.status === 'draft' || c.status === 'planned' || c.tasks.length === 0) {
    return 'planning'
  }
  if (allTasksSettled(c)) return 'review'
  const needs = c.tasks.some((t) => {
    const d = dotOf(t, c.tasks)
    return d === 'needs-you' || d === 'failed' || d === 'conflict'
  })
  return needs ? 'needs-you' : 'running'
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
  task: Pick<CampaignTask, 'status' | 'dependsOn'> &
    Partial<Pick<CampaignTask, 'verdict'>>,
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
    case 'planning':
    case 'review':
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
  /** Finished, but the check could not decide: a person chooses. */
  | 'verifyBlocked'
  | 'ready'
  | 'needsInput'
  | 'needsApproval'
  | 'failed'
  | 'conflict'
  | 'resolving'
  | 'waiting'
  /** Waits for a task that was skipped: a person decides. */
  | 'waitingSkipped'
  | 'queued'
  | 'merged'
  | 'skipped'

export function wordOf(
  task: Pick<CampaignTask, 'status' | 'dependsOn'> &
    Partial<Pick<CampaignTask, 'verdict'>>,
  all: readonly Pick<CampaignTask, 'id' | 'status' | 'title'>[] = []
): { word: TaskWord; waitingFor: string[] } {
  const waitingFor = task.dependsOn
    .map((d) => all.find((t) => t.id === d))
    .filter((t) => t && t.status !== 'merged')
    .map((t) => t!.title)
  const only = (word: TaskWord) => ({ word, waitingFor: [] as string[] })
  if (isResolving(task)) return only('resolving')
  const skipped = skippedDepsOf(task, all)
  if (skipped.length > 0) {
    return { word: 'waitingSkipped', waitingFor: skipped.map((t) => t.title) }
  }
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
      return only(isVerificationBlocked(task) ? 'verifyBlocked' : 'checking')
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
    case 'resolving':
      return only('resolving')
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
  /** The final build and test check failed. */
  | 'gateFailed'
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
  skipped: number
  total: number
}

/** The campaign in one line a person can read without knowing the states. */
export function headlineOf(
  c: Pick<Campaign, 'status' | 'tasks'> & { gate?: unknown }
): Headline {
  const { merged: done, skipped, total } = taskCounts(c.tasks)
  const groups = groupTasks(c.tasks)
  const countIn = (g: TaskGroup) =>
    groups.find((x) => x.group === g)?.tasks.length ?? 0
  const make = (key: HeadlineKey, count = 0): Headline => ({
    key,
    count,
    done,
    skipped,
    total,
  })
  // A failed final check is not "ready": say so before anything else.
  if (c.status === 'reviewing' && gateFailedOf(c)) return make('gateFailed')
  // Only merged and skipped tasks remain: nothing is left to run.
  if (
    (c.status === 'running' || c.status === 'approved') &&
    allTasksSettled(c)
  ) {
    return make('review')
  }
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
      if (allTasksSettled(c)) return 'review'
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
  /** The task's state, or for the coordinator the campaign's own state. */
  dot?: CampaignDot
}

export type CampaignGroup = {
  campaignId: string
  title: string
  status: CampaignStatus
  done: number
  skipped: number
  total: number
  /** Over for good: the sidebar folds it to one line. */
  finished: boolean
  /** The group's one header mark: the campaign's own state. */
  dot: CampaignDot
  /** Something waits on the person: a task needs them, or review is open. */
  attention: boolean
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
    take({
      sessionId: c.coordinatorSession,
      role: 'coordinator',
      dot: coordinatorDotOf(c),
    })
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
          : { dot: coordinatorDotOf(c) }),
      })
    }
    if (rows.length === 0) continue
    groups.push({
      campaignId: c.id,
      title: c.title,
      status: c.status,
      done: c.tasks.filter((t) => t.status === 'merged').length,
      skipped: c.tasks.filter((t) => t.status === 'cancelled').length,
      total: c.tasks.length,
      finished: FINISHED.has(c.status),
      dot: coordinatorDotOf(c),
      attention: ['needs-you', 'failed', 'conflict', 'review'].includes(
        coordinatorDotOf(c)
      ),
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
  task: Pick<CampaignTask, 'status' | 'sessionId' | 'attempt'> &
    Partial<Pick<CampaignTask, 'verdict'>>
): {
  open: boolean
  note: boolean
  stop: boolean
  retry: boolean
  /** Run the verification again (a finished task that is not verified yet). */
  verify: boolean
  /** Start the automatic conflict resolver (a task in conflict). */
  resolve: boolean
  /** "Accept anyway": a person accepts a task whose check was blocked. */
  accept: boolean
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
    verify: s === 'completed' || s === 'verifying',
    resolve: s === 'conflict',
    accept: isVerificationBlocked(task),
    // The same set campaign_merge skip accepts.
    skip: ['failed', 'conflict', 'completed', 'blocked', 'interrupted'].includes(s),
    handoff: !['pending', 'blocked', 'queued'].includes(s),
  }
}

export type TaskActionName =
  | 'open'
  | 'note'
  | 'stop'
  | 'retry'
  | 'verify'
  | 'accept'
  | 'skip'
  | 'handoff'

/**
 * The recoverable state of a finished task whose check did not pass, for a
 * card to render: why it is stuck, what it holds up, and the actions on
 * offer in the order a person should consider them (check again, accept it,
 * skip it). `null` for any task that is not waiting on that decision.
 */
export function recoveryOf(
  task: Pick<CampaignTask, 'id' | 'status' | 'sessionId' | 'attempt' | 'detail'> &
    Partial<Pick<CampaignTask, 'verdict'>>,
  all: readonly Pick<CampaignTask, 'id' | 'status' | 'dependsOn'>[] = []
): {
  state: 'verification-blocked'
  reason: string
  /** Tasks that cannot start until this one is merged or skipped. */
  blocks: string[]
  actions: TaskActionName[]
} | null {
  if (!isVerificationBlocked(task)) return null
  const can = taskActionsOf(task)
  const actions: TaskActionName[] = []
  if (can.verify) actions.push('verify')
  if (can.accept) actions.push('accept')
  if (can.skip) actions.push('skip')
  if (can.open) actions.push('open')
  if (can.handoff) actions.push('handoff')
  const reason = task.detail.replace(/^verification blocked:\s*/i, '').trim()
  return {
    state: 'verification-blocked',
    reason: reason || 'the check could not decide',
    blocks: all
      .filter(
        (t) =>
          t.status !== 'merged' &&
          t.status !== 'cancelled' &&
          t.dependsOn.includes(task.id)
      )
      .map((t) => t.id),
    actions,
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
