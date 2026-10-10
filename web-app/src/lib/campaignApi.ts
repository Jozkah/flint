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
}

export type CampaignApi = typeof campaignApi
