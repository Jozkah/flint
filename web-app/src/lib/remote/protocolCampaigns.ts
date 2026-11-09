// The remote-access wire protocol: campaigns. Re-exported by protocol.ts; free
// of app imports.

// ---------------------------------------------------------------------------
// Campaigns (the desktop's Campaigns board, read and steered from a phone)
// ---------------------------------------------------------------------------

/** What the board offers on a campaign or one of its tasks. Mutations travel
 * under an `approvals.` name so the server's approvals switch covers them. */
export type CampaignActionWire =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'finalize'
  | 'apply'
  | 'retry'
  | 'skip'
  | 'stop'

export type CampaignTaskWire = {
  id: string
  title: string
  /** `CampaignTaskStatus` of the desktop's model. */
  status: string
  dependsOn: string[]
  attempt: number
  sessionId: string | null
  /** The latest note on the task (the failure text, the retry hint). */
  detail: string
  verdict: string | null
  /** Counts only, from the task's worktree; null when not asked or unknown. */
  files: { count: number; added: number; removed: number; uncommitted: boolean } | null
}

export type CampaignWire = {
  id: string
  title: string
  /** `CampaignStatus` of the desktop's model. */
  status: string
  coordinatorSession: string
  updatedAt: string
  tasks: CampaignTaskWire[]
  maxParallel: number
  tokenBudget: number | null
  tokensUsed: number
  proposalId: string | null
  gate: { passed: boolean; skipped: boolean; command: string } | null
}

export type CampaignProposalFileWire = {
  path: string
  change: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  binary: boolean
  /** Never applied, whatever is chosen. */
  sensitive: boolean
  /** One line per review flag; the file needs a tick before it is applied. */
  flags: string[]
}

export type CampaignDetailResult = {
  campaign: CampaignWire
  proposal: { id: string; state: string; files: CampaignProposalFileWire[] } | null
  /** The command the gate will run, while the campaign waits for review. */
  gateCommand: string | null
}

export type CampaignActParams = {
  id: string
  action: CampaignActionWire
  taskId?: string
  /** `apply`: flagged files the person marked as looked at. */
  acknowledged?: string[]
}

/** Every method a phone may call, with its params and result. */
