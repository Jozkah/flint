/**
 * The Tauri commands behind Campaigns (src-tauri/src/core/agent/campaign.rs).
 * Thin on purpose: the backend validates and records, this only calls.
 */
import { invoke } from '@tauri-apps/api/core'
import type {
  Campaign,
  CampaignAction,
  CampaignStatus,
  CampaignTaskStatus,
  CampaignLimits,
  LiveState,
  PlanTask,
  TaskCheck,
} from '@/lib/campaignModel'

/** One edit of a plan that is not approved yet (`agent_campaign_plan_update`). */
export type PlanOp =
  | { op: 'add'; task: PlanTask; at?: number }
  | {
      op: 'update'
      id: string
      title?: string
      brief?: string
      acceptance?: string[]
      paths?: string[]
      dependsOn?: string[]
    }
  | { op: 'remove'; id: string }
  | { op: 'reorder'; ids: string[] }
  | { op: 'replace'; tasks: PlanTask[] }

export type PlanEdit = {
  ops?: PlanOp[]
  title?: string
  /** 0 clears the token budget. */
  tokenBudget?: number
}

/** What `agent_campaign_resolve` returns: the resolver's seed and worktree. */
export type ResolvePlan = {
  taskId: string
  sessionId: string
  branch: string
  worktreePath: string
  baseSha: string
  files: string[]
  clean: boolean
  brief: string
  campaign: Campaign
}

export type CampaignCreateInput = {
  id?: string
  title: string
  coordinatorSession: string
  sourceRoot: string
  baseBranch?: string
  baseSha?: string
  modeCeiling: string
  model?: string
  limits?: Partial<CampaignLimits>
  tasks: PlanTask[]
}

export type TaskPatch = {
  sessionId?: string
  branch?: string
  worktreePath?: string
  baseSha?: string
  tokensUsed?: number
  fingerprint?: string
  detail?: string
  /**
   * With a move to `verified` from `completed`: accept a task whose
   * verification did not pass. The backend records who and why.
   */
  accept?: { by: string; reason?: string }
}

export type CampaignTransition = {
  campaign?: CampaignStatus
  task?: { id: string; to: CampaignTaskStatus; patch?: TaskPatch }
  integration?: {
    branch: string
    worktree: string
    baseBranch?: string
    baseSha?: string
    /** The plan card's choice, recorded with the approval. */
    modeCeiling?: string
    taskAccess?: 'worktree' | 'ask'
  }
}

export type SettleInput = {
  outcome: 'completed' | 'failed' | 'cancelled'
  detail?: string
  handoff?: string
  tokensUsed?: number
  fingerprint?: string
}

export type CampaignContext = {
  decisions: string
  handoffs: { taskId: string; text: string }[]
  /** A resolver task's brief (written when the resolver was prepared). */
  resolutions?: { taskId: string; text: string }[]
}

export type VerifyRequest = {
  taskId: string
  /** A chat-completions body: system prompt and fenced evidence. */
  request: {
    model?: string
    messages: { role: string; content: string }[]
  }
  evidenceNote: string
}

export type VerifyNext = 'verified' | 'repair' | 'failed' | 'blocked'

export type VerifyOutcome = {
  taskId: string
  verdict: string
  next: VerifyNext
  evidence: string
  /** Why a verifier PASS was taken back, when it was. */
  downgraded?: string | null
  /** The objective check this verification ran, when there was one. */
  check?: TaskCheck | null
  campaign: Campaign
}

export type MergeReport = {
  taskId: string
  merged: boolean
  mergedSha?: string | null
  alreadyMerged: boolean
  conflicts: string[]
  status: CampaignTaskStatus
  campaignStatus: CampaignStatus
}

export type IntegrateReport = {
  merged: string[]
  conflicts: { taskId: string; files: string[] }[]
  skipped: string[]
  errors: string[]
  campaign: Campaign
}

/** One file a task changed (`agent_campaign_task_diff`). */
export type TaskDiffFile = {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  oldPath?: string | null
  added: number
  removed: number
  binary: boolean
  /** Unified diff from the first hunk; absent for binary or over-size files. */
  patch?: string | null
  truncated: boolean
}

export type TaskDiff = {
  files: TaskDiffFile[]
  added: number
  removed: number
  truncated: boolean
  /** The worktree holds work that is not committed yet. */
  uncommitted: boolean
}

export type GateChoice = { source: string; command?: string | null }

export type FinalizeReport = {
  gate: NonNullable<Campaign['gate']>
  proposalId?: string | null
  files: number
  warning?: string | null
  campaign: Campaign
}

export type OrphanWorktree = {
  campaignId: string
  taskId?: string | null
  path: string
  branch: string
  campaignStatus: CampaignStatus
  pending: string[]
  unmerged: string[]
}

export const campaignApi = {
  create: (input: CampaignCreateInput) =>
    invoke<Campaign>('agent_campaign_create', { input }),
  get: (id: string) => invoke<Campaign>('agent_campaign_get', { id }),
  list: () => invoke<Campaign[]>('agent_campaign_list'),
  transition: (id: string, input: CampaignTransition) =>
    invoke<Campaign>('agent_campaign_transition', { id, input }),
  settle: (id: string, taskId: string, input: SettleInput) =>
    invoke<Campaign>('agent_campaign_task_settle', { id, taskId, input }),
  cancel: (id: string, detail?: string) =>
    invoke<Campaign>('agent_campaign_cancel', { id, detail: detail ?? null }),
  decide: (id: string, text: string) =>
    invoke<void>('agent_campaign_decisions_append', { id, text }),
  context: (id: string, taskIds: string[]) =>
    invoke<CampaignContext>('agent_campaign_context', { id, taskIds }),
  events: (id: string) =>
    invoke<
      { ts: string; kind: string; task?: string | null; detail: string }[]
    >('agent_campaign_events', { id }),
  notified: (id: string, taskId: string) =>
    invoke<void>('agent_campaign_notified', { id, taskId }),
  verifyPrepare: (
    id: string,
    taskId: string,
    modelId: string,
    runChecks = true
  ) =>
    invoke<VerifyRequest>('agent_campaign_verify_prepare', {
      id,
      taskId,
      modelId,
      runChecks,
    }),
  verifyFinish: (
    id: string,
    taskId: string,
    reply: string | null,
    error: string | null,
    tokens: number
  ) =>
    invoke<VerifyOutcome>('agent_campaign_verify_finish', {
      id,
      taskId,
      reply,
      error,
      tokens,
    }),
  mergeTask: (id: string, taskId: string) =>
    invoke<MergeReport>('agent_campaign_merge_task', { id, taskId }),
  integrate: (id: string) =>
    invoke<IntegrateReport>('agent_campaign_integrate', { id }),
  gatePlan: (id: string) =>
    invoke<GateChoice>('agent_campaign_gate_plan', { id }),
  finalize: (id: string, seconds?: number) =>
    invoke<FinalizeReport>('agent_campaign_finalize', {
      id,
      seconds: seconds ?? null,
    }),
  refresh: (id: string) => invoke<Campaign>('agent_campaign_refresh', { id }),
  orphans: () => invoke<OrphanWorktree[]>('agent_campaign_orphans'),
  /** `patches: false` counts only; the board's rows poll that. */
  taskDiff: (id: string, taskId: string, patches = true) =>
    invoke<TaskDiff>('agent_campaign_task_diff', { id, taskId, patches }),
  /** The integration branch's whole change against the base. */
  campaignDiff: (id: string, patches = true) =>
    invoke<TaskDiff>('agent_campaign_diff', { id, patches }),
  /** Edit a planned (not approved) campaign; the whole plan is re-validated. */
  planUpdate: (id: string, edit: PlanEdit) =>
    invoke<Campaign>('agent_campaign_plan_update', { id, edit }),
  /** The scheduler's decision, made by the backend (the source of truth). */
  nextActions: (id: string, live: LiveState, maxParallel: number) =>
    invoke<CampaignAction[]>('agent_campaign_next_actions', {
      id,
      live,
      maxParallel,
    }),
  /** Start a resolver for a conflicted task in the session just created. */
  resolve: (id: string, taskId: string, sessionId: string) =>
    invoke<ResolvePlan>('agent_campaign_resolve', { id, taskId, sessionId }),
  /** True the first time per key; recorded in the event log. */
  claimNotice: (id: string, key: string) =>
    invoke<boolean>('agent_campaign_claim_notice', { id, key }),
  // -- A server-driven campaign (`flint serve --agent-run`, P3) -------------
  /**
   * Plan a campaign on the server for a goal: the server's model proposes the
   * tasks (or `options.plan` is used as given) and the campaign is stored
   * `planned`, waiting for `approve`. Nothing runs before that.
   */
  startServer: (goal: string, folder: string, options?: ServerCampaignOptions) =>
    invoke<Campaign>('agent_campaign_start_server', {
      goal,
      folder,
      options: options ?? {},
    }),
  /**
   * Approve a planned server campaign. `worktree` lets tasks work unattended
   * inside their own folder (needs the operator's `--agent-allow-bypass`);
   * `ask` makes every action ask.
   */
  approve: (id: string, access: 'worktree' | 'ask') =>
    invoke<Campaign>('agent_campaign_approve', { id, access }),
  /** What waits on a person across the server's campaigns. */
  approvals: () =>
    invoke<{ approvals: ServerApproval[] }>('agent_campaign_approvals'),
}

export type ServerCampaignOptions = {
  model?: string
  title?: string
  maxParallel?: number
  tokenBudget?: number
  taskTokens?: number
  taskSteps?: number
  wallClockSecs?: number
  /** A plan to use instead of asking the model. */
  plan?: PlanTask[]
}

export type ServerApproval = {
  campaignId: string
  kind: 'plan' | 'finalize' | 'task'
  title?: string
  taskId?: string
  sessionId?: string | null
}

export type CampaignApi = typeof campaignApi
