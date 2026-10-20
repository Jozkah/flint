/**
 * The agent tools the backend adds for cross-session messaging
 * (docs/SESSION_MESSAGING.md). Session scope only: advertised to Cowork runs,
 * never to chat threads, never to subagents.
 *
 * Kept in a dependency-free module so the tool-list code can import the names
 * without pulling in the mailbox client.
 */

import { CAMPAIGN_PLAN_TOOL_NAME } from '@/lib/campaignToolNames'
import { WORKFLOW_TOOL_NAME } from '@/lib/workflowToolName'
import { SPAWN_SESSION_TOOL_NAME } from '@/lib/spawnSessionName'

/** The one messaging tool that acts on another session. */
export const STOP_SESSION_TOOL_NAME = 'stop_session'

export const SESSION_MESSAGING_TOOL_NAMES = [
  'list_sessions',
  'send_message',
  'read_messages',
  'wait_for_reply',
  STOP_SESSION_TOOL_NAME,
] as const

export const SESSION_MESSAGING_TOOLS: ReadonlySet<string> = new Set(
  SESSION_MESSAGING_TOOL_NAMES
)

/**
 * Tools whose every call is put to the user. No standing grant answers for
 * them -- not "allow all", not "always allow", not "allow in this
 * conversation" -- and the prompt offers only "Allow once". Stopping another
 * session is an action on something the user of this session may not be
 * looking at, so each one is decided on its own. Approving a campaign plan
 * starts several sessions that spend and change files, so it is decided the
 * same way, and approving it does not pre-approve any call a task makes. A
 * large `workflow` is asked the same way (small ones never reach the prompt).
 */
export const ALWAYS_ASK_TOOLS: ReadonlySet<string> = new Set([
  STOP_SESSION_TOOL_NAME,
  CAMPAIGN_PLAN_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
  // Only asked for `worktree: true` (the gate runs in spawnSession).
  SPAWN_SESSION_TOOL_NAME,
])

/** Longest stop reason, matching the backend. */
export const MAX_STOP_REASON_CHARS = 500
