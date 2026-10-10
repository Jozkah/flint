/**
 * Campaigns: the renderer's view of the backend record, and the pure decisions
 * made on it (docs/CAMPAIGNS.md).
 *
 * The backend record (`src-tauri/src/core/agent/campaign.rs`) is the truth for
 * status. Nothing here persists anything; `nextActions` is a port of
 * `campaign_scheduler::next_actions` so the renderer can decide synchronously
 * on every store change. Keep the two in step.
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
}

export type CampaignLimits = {
  maxParallel: number
  maxTasks: number
  tokenBudget?: number | null
  taskTokens?: number | null
  taskSteps?: number | null
  wallClockSecs?: number | null
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

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export type LiveState = {
  /** Task ids with a run actually going on screen right now. */
  liveTasks: string[]
  /** Panes free to open, when that is a tighter limit than `maxParallel`. */
  freePanes?: number
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
    const spent = campaign.tasks.reduce((n, t) => n + t.tokensUsed, 0)
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
