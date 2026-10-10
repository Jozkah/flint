/**
 * The names of the campaign tools (docs/CAMPAIGNS.md). Dependency-free so the
 * approval and tool-list code can import them without the executor.
 *
 * Coordinator session only: advertised to a top-level Cowork run that is not
 * itself a campaign task, never to chat, subagents or tasks.
 */
export const CAMPAIGN_PLAN_TOOL_NAME = 'campaign_plan'
export const CAMPAIGN_STATUS_TOOL_NAME = 'campaign_status'
export const CAMPAIGN_COLLECT_TOOL_NAME = 'campaign_collect'
export const CAMPAIGN_CANCEL_TOOL_NAME = 'campaign_cancel'
export const CAMPAIGN_STEER_TOOL_NAME = 'campaign_steer'
export const CAMPAIGN_DECIDE_TOOL_NAME = 'campaign_decide'

export const CAMPAIGN_TOOL_NAMES = [
  CAMPAIGN_PLAN_TOOL_NAME,
  CAMPAIGN_STATUS_TOOL_NAME,
  CAMPAIGN_COLLECT_TOOL_NAME,
  CAMPAIGN_CANCEL_TOOL_NAME,
  CAMPAIGN_STEER_TOOL_NAME,
  CAMPAIGN_DECIDE_TOOL_NAME,
] as const

export const CAMPAIGN_TOOLS: ReadonlySet<string> = new Set(CAMPAIGN_TOOL_NAMES)
