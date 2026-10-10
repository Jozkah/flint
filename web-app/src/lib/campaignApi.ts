/**
 * The Tauri commands behind Campaigns (src-tauri/src/core/agent/campaign.rs).
 * Thin on purpose: the backend validates and records, this only calls.
 */
import { invoke } from '@tauri-apps/api/core'
import type {
  Campaign,
  CampaignStatus,
  CampaignTaskStatus,
  CampaignLimits,
  PlanTask,
} from '@/lib/campaignModel'

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
}

export type CampaignTransition = {
  campaign?: CampaignStatus
  task?: { id: string; to: CampaignTaskStatus; patch?: TaskPatch }
  integration?: {
    branch: string
    worktree: string
    baseBranch?: string
    baseSha?: string
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
    invoke<{ ts: string; kind: string; task?: string | null; detail: string }[]>(
      'agent_campaign_events',
      { id }
    ),
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
}

export type CampaignApi = typeof campaignApi
