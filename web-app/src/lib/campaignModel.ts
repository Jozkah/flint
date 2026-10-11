/**
 * Campaigns: the renderer's view of the backend record, and the pure decisions
 * made on it (docs/CAMPAIGNS.md).
 *
 * The backend record (`src-tauri/src/core/agent/campaign.rs`) is the truth for
 * status. Nothing here persists anything. `nextActions` is only the FALLBACK
 * of `campaign_scheduler::next_actions`: the runner asks the backend command
 * `agent_campaign_next_actions` and uses this when the command is unavailable
 * (tests, a browser). Both are driven by the same fixtures
 * (`campaignScheduler.fixtures.json`); keep them in step.
 */
import type { CoworkMode } from '@/lib/coworkMode'

/** Most tasks one plan may hold. Mirrors `campaign::MAX_TASKS`. */
export const CAMPAIGN_MAX_TASKS = 12

/** `campaigns.maxParallel`: default, and the range the setting may take. */
export const CAMPAIGN_DEFAULT_MAX_PARALLEL = 4
export const CAMPAIGN_MIN_PARALLEL = 1
/** Matches the split-pane hard maximum (`SPLIT_MAX_MAX_PANES`). */
export const CAMPAIGN_MAX_PARALLEL_CAP = 6

/** The user's setting, forced into the allowed range. Mirrors `clamp_max_parallel`. */
export function clampCampaignParallel(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return CAMPAIGN_DEFAULT_MAX_PARALLEL
  return Math.min(
    CAMPAIGN_MAX_PARALLEL_CAP,
    Math.max(CAMPAIGN_MIN_PARALLEL, Math.round(n))
  )
}

export type CampaignStatus =
  | 'draft'
  | 'planned'
  | 'approved'
  | 'running'
  | 'paused'
  | 'reviewing'
  | 'merging'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type CampaignTaskStatus =
  | 'pending'
  | 'blocked'
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'awaiting_approval'
  | 'completed'
  | 'verifying'
  | 'verified'
  | 'merged'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'conflict'
  /** A resolver session is merging a conflicted task (one attempt). */
  | 'resolving'

export type CampaignTask = {
  id: string
  title: string
  brief: string
  acceptance: string[]
  paths: string[]
  dependsOn: string[]
  sessionId?: string | null
  branch?: string | null
  worktreePath?: string | null
  baseSha?: string | null
  status: CampaignTaskStatus
  attempt: number
  verdict?: 'PASS' | 'PARTIAL' | 'FAIL' | 'BLOCKED' | null
  tokensUsed: number
  handoffPath?: string | null
  mergedSha?: string | null
  fingerprint?: string | null
  detail: string
  /** Tokens the verifier's own calls cost, over every verification. */
  verifyTokens?: number
  /**
   * What the last verification established itself: the objective check, an
   * empty diff, conflict markers left by a resolver.
   */
  evidence?: TaskEvidence | null
  /** Set once a resolver was started for this task's conflict (one attempt). */
  resolver?: TaskResolver | null
  /**
   * Set when a person accepted the task although its verification did not
   * pass ("accept anyway"): who, why, and what the verifier had said.
   */
  manualOverride?: {
    by: string
    reason: string
    at: string
    previousVerdict?: 'PASS' | 'PARTIAL' | 'FAIL' | 'BLOCKED' | null
  } | null
}

export type TaskCheck = {
  command: string
  source: string
  exitCode?: number | null
  timedOut: boolean
  passed: boolean
  output: string
  at: string
}

export type TaskEvidence = {
  empty: boolean
  markers: string[]
  check?: TaskCheck | null
  at: string
}

export type TaskResolver = {
  attempts: number
  files: string[]
  originalSessionId?: string | null
  originalBranch?: string | null
  originalWorktreePath?: string | null
  originalBaseSha?: string | null
  worktreePath: string
  branch: string
  at: string
}

/** A rough token cost of a plan, made before approval. */
export type CostEstimate = {
  tasks: number
  perTaskLow: number
  perTaskExpected: number
  perTaskHigh: number
  low: number
  expected: number
  high: number
  /** `history` (earlier campaigns' tasks) or `default`. */
  basis: 'history' | 'default'
  samples: number
}

export type CampaignLimits = {
  maxParallel: number
  maxTasks: number
  tokenBudget?: number | null
  taskTokens?: number | null
  taskSteps?: number | null
  wallClockSecs?: number | null
  /**
   * What the user chose at the plan card: `worktree` (tasks edit and run
   * tests inside their own folder without asking; the rest still asks) or
   * `ask` (every action asks). Absent on a plan made before the choice.
   */
  taskAccess?: 'worktree' | 'ask' | null
}

export type Campaign = {
  schemaVersion: number
  id: string
  title: string
  coordinatorSession: string
  sourceRoot: string
  baseBranch: string
  baseSha: string
  integrationBranch: string
  integrationWorktree: string
  modeCeiling: string
  model: string
  limits: CampaignLimits
  status: CampaignStatus
  processEpoch: string
  createdAt: string
  updatedAt: string
  tasks: CampaignTask[]
  /** The last final build and test gate run. */
  gate?: CampaignGate | null
  /** The proposal handed to the user's checkout, once the gate passed. */
  proposalId?: string | null
  /** A rough cost range of the plan, set when it is recorded or edited. */
  estimate?: CostEstimate | null
}

/** The tasks of a plan can be edited only before it is approved. */
export const isPlanEditable = (c: Pick<Campaign, 'status'>): boolean =>
  c.status === 'planned' || c.status === 'draft'

/** What a task cost: the worker's run and the verifier's calls. */
export const taskTokens = (
  t: Pick<CampaignTask, 'tokensUsed' | 'verifyTokens'>
): number => t.tokensUsed + (t.verifyTokens ?? 0)

/** A task the campaign cannot finish without a person (or a resolver). */
export const isConflictParked = (t: CampaignTask): boolean =>
  t.status === 'conflict' && (t.resolver?.attempts ?? 0) >= 1

export type CampaignGate = {
  /** `agent_toml`, `detected` or `none`. */
  source: string
  command: string
  skipped: boolean
  passed: boolean
  timedOut: boolean
  exitCode?: number | null
  output: string
  at: string
}

/** A task as the coordinator proposes it. */
export type PlanTask = {
  id: string
  title: string
  brief: string
  acceptance?: string[]
  paths?: string[]
  dependsOn?: string[]
}

/** Occupies a pane: the worker is running or waiting on a person. */
export const isLiveTask = (s: CampaignTaskStatus): boolean =>
  s === 'running' || s === 'awaiting_input' || s === 'awaiting_approval'

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

const MODE_ORDER: readonly CoworkMode[] = ['review', 'ask', 'auto', 'bypass']

/**
 * The ceiling a campaign carries: the coordinator's own mode, except that
 * `bypass` is never inherited, so it is capped at `auto`.
 */
export function campaignCeiling(coordinator: CoworkMode): CoworkMode {
  return coordinator === 'bypass' ? 'auto' : coordinator
}

/** What a task runs in unless the ceiling is lower: its own worktree, so `auto`. */
export const DEFAULT_TASK_MODE: CoworkMode = 'auto'

/**
 * A task's mode: the lower of the ceiling and the default, and never
 * `bypass` whatever the ceiling string says.
 */
export function taskModeFor(ceiling: string): CoworkMode {
  const known = MODE_ORDER.includes(ceiling as CoworkMode)
    ? (ceiling as CoworkMode)
    : 'ask'
  const cap = campaignCeiling(known)
  return MODE_ORDER.indexOf(cap) < MODE_ORDER.indexOf(DEFAULT_TASK_MODE)
    ? cap
    : DEFAULT_TASK_MODE
}

/**
 * How tasks work, as the plan card puts it to the user.
 *
 * - `worktree` (recommended): Auto mode inside the task's own managed
 *   worktree. Edits and test commands there run without asking; anything
 *   outside it, a delete outside it, network access and destructive commands
 *   still ask, exactly as Auto mode always does. Never bypass.
 * - `ask`: every action asks.
 */
export type TaskAccess = 'worktree' | 'ask'

export const DEFAULT_TASK_ACCESS: TaskAccess = 'worktree'

/** The highest mode tasks may run in for a choice. Never `bypass`. */
export function ceilingForAccess(access: TaskAccess): CoworkMode {
  return access === 'ask' ? 'ask' : 'auto'
}

export const TASK_ACCESS_QUESTION = 'How should the tasks work?'

export const TASK_ACCESS_OPTIONS: {
  id: TaskAccess
  label: string
  description: string
}[] = [
  {
    id: 'worktree',
    label: 'Let tasks work on their own inside their own folder (recommended)',
    description:
      'Edits and test commands in the task worktree run without asking. ' +
      'Anything outside it, deletes outside the worktree, network and ' +
      'destructive commands still ask.',
  },
  {
    id: 'ask',
    label: 'Ask for each action',
    description:
      'Every write and shell command in a task waits for you. Slower, and ' +
      'each task will often be waiting on you.',
  },
]

/** A choice id from a card, or the recommended one when it is absent or unknown. */
export function parseTaskAccess(value: unknown): TaskAccess {
  return value === 'ask' || value === 'worktree' ? value : DEFAULT_TASK_ACCESS
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export type LiveState = {
  /** Task ids with a run actually going on screen right now. */
  liveTasks: string[]
  /** Panes free to open, when that is a tighter limit than `maxParallel`. */
  freePanes?: number
  /** Tokens live runs have used so far, by task id. */
  liveTokens?: Record<string, number>
}

export type CampaignAction =
  | { action: 'start'; taskId: string }
  | { action: 'block'; taskId: string; because: string }

/**
 * Tasks to start now, in plan order, and tasks to block.
 *
 * A task starts when it is `pending` or `queued`, every dependency is
 * `merged`, the campaign is `running`, and a slot is free. Slots are
 * `min(maxParallel, cap, running + freePanes)` minus tasks already live. Once
 * the token budget is spent nothing starts. A pending task whose dependency
 * was cancelled is blocked rather than left waiting forever.
 */
export function nextActions(
  campaign: Campaign,
  live: LiveState,
  maxParallel: number
): CampaignAction[] {
  if (campaign.status !== 'running') return []
  const actions: CampaignAction[] = []
  const statusOf = (id: string) =>
    campaign.tasks.find((t) => t.id === id)?.status

  for (const t of campaign.tasks) {
    if (t.status !== 'pending' && t.status !== 'queued') continue
    const dead = t.dependsOn.find((d) => statusOf(d) === 'cancelled')
    if (dead) {
      actions.push({
        action: 'block',
        taskId: t.id,
        because: `dependency ${dead} was cancelled`,
      })
    }
  }

  const budget = campaign.limits.tokenBudget
  if (budget != null) {
    const spent = campaign.tasks.reduce(
      (n, t) =>
        n +
        Math.max(t.tokensUsed, live.liveTokens?.[t.id] ?? 0) +
        (t.verifyTokens ?? 0),
      0
    )
    if (spent >= budget) return actions
  }

  const counted = new Set<string>([
    ...campaign.tasks.filter((t) => isLiveTask(t.status)).map((t) => t.id),
    ...live.liveTasks,
  ])
  let cap = clampCampaignParallel(maxParallel)
  if (live.freePanes != null) {
    cap = Math.min(cap, counted.size + Math.max(0, live.freePanes))
  }
  let slots = Math.max(0, cap - counted.size)

  for (const t of campaign.tasks) {
    if (slots === 0) break
    if (t.status !== 'pending' && t.status !== 'queued') continue
    if (counted.has(t.id)) continue
    if (t.dependsOn.every((d) => statusOf(d) === 'merged')) {
      actions.push({ action: 'start', taskId: t.id })
      slots -= 1
    }
  }
  return actions
}
