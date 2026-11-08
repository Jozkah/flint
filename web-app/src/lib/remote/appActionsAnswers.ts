// `RemoteActions` for answering: approvals, asks, prompts, message actions and
// interrupted turns.

import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import {
  allApprovalRequests,
  canTemporarilyAllowGit,
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'
import { answerAsk } from '@/lib/coworkRunner'
import { appAsks } from './appAsks'
import { appPrompts, respondAppPrompt } from './appPrompts'
import { describePermissionRequest } from '@/lib/permissionRequest'
import { remoteApi } from './api'
import { waitForChatActions } from './composer'
import type { ApprovalScopeWire, RemoteActions } from './actions'

const SCOPE_WIRE = {
  'allow-git-temporary': 'temporary',
  'allow-once': 'once',
  'allow-thread': 'thread',
  'allow-always': 'always',
} as const

export function answerActions(): Pick<
  RemoteActions,
  | 'findApproval'
  | 'resolveApproval'
  | 'findAsk'
  | 'answerAsk'
  | 'chatAct'
  | 'findPrompt'
  | 'respondPrompt'
  | 'recoverInterrupted'
  | 'permissions'
> {
  return {
    findApproval: (requestId) => {
      const entry = allApprovalRequests(useToolApprovalRequests.getState()).find(
        (a) => a.requestId === requestId
      )
      if (!entry) return null
      const scopes: ApprovalScopeWire[] = describePermissionRequest(entry).scopesOffered.map(
        (s) => SCOPE_WIRE[s]
      )
      // The desktop card's "Allow all temporarily" (#45), when it may cover this call.
      if (canTemporarilyAllowGit(entry.toolName, entry.input, entry.threadIsEphemeral === true)) {
        scopes.push('temporary')
      }
      return { toolCallId: entry.toolCallId, scopes }
    },

    resolveApproval: (toolCallId, requestId, decision) =>
      useToolApprovalRequests.getState().resolveApproval(toolCallId, decision, requestId),

    findAsk: (threadId, requestId) =>
      appAsks().find((a) => a.threadId === threadId && a.requestId === requestId) ?? null,

    // Through the run that asked, exactly as the desktop's card answers: the
    // run's own resolver settles the card and applies what the answer means
    // (leaving plan mode, continuing an accepted proposal).
    answerAsk: (threadId, requestId, answers) => answerAsk(threadId, requestId, answers),

    chatAct: async (id, action) => {
      const entry = await waitForChatActions(id)
      if (!entry) return false
      if (action.type === 'regenerate') entry.regenerate(action.messageId)
      else entry.edit(action.messageId, action.text)
      return true
    },

    findPrompt: (id) => appPrompts().find((p) => p.id === id) ?? null,
    respondPrompt: (id, action) => respondAppPrompt(id, action),

    // The completed steps are kept and the unfinished reply with them, as the
    // desktop's "Continue" on an interrupted turn does.
    recoverInterrupted: (id) => {
      useCoworkSessions.getState().recoverInFlight(id, 'continue')
    },

    permissions: async () => {
      const status = await remoteApi.getStatus().catch(() => null)
      return status
        ? { approvals: status.config.allowApprovals, alwaysAllow: status.config.allowAlwaysAllow }
        : null
    },
  }
}
