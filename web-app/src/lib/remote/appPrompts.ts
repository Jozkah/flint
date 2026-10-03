// The window's blocking prompts read from their stores, and a phone's answer
// applied through the same store call the desktop's own dialog makes (see
// `prompts.ts` for what a phone may answer).

import { useAccessRequests } from '@/lib/accessRequests'
import { useBrowserAgentPrompt } from '@/hooks/useBrowserAgentPrompt'
import { useContextSizeApproval } from '@/hooks/useModelContextApproval'
import { useTeamConflictRequests } from '@/hooks/useTeamConflictRequests'
import { conflictKey, type ConflictDecision } from '@/lib/coworkTeam'
import { accessPrompt, conflictPrompt, contextPrompt, domainPrompt, offers } from './prompts'
import type { RemotePrompt } from './protocol'

export function appPrompts(): RemotePrompt[] {
  const out: RemotePrompt[] = []
  // Only the head of each queue is on screen on the computer; the rest wait
  // their turn there, and so here.
  const access = useAccessRequests.getState().queue[0]
  if (access) out.push(accessPrompt(access))
  const domain = useBrowserAgentPrompt.getState().queue[0]
  if (domain) out.push(domainPrompt(domain))
  for (const c of Object.values(useTeamConflictRequests.getState().bySession)) out.push(conflictPrompt(c))
  if (useContextSizeApproval.getState().modalProps) out.push(contextPrompt())
  return out
}

/** Answers the prompt `id` with one of its actions. False when it is gone. */
export function respondAppPrompt(id: string, action: string): boolean {
  const prompt = appPrompts().find((p) => p.id === id)
  if (!prompt || !offers(prompt, action)) return false
  const rest = id.slice(id.indexOf(':') + 1)
  switch (prompt.kind) {
    case 'access':
      useAccessRequests.getState().answer(rest, action === 'session' ? 'session' : 'deny')
      return true
    case 'domain':
      useBrowserAgentPrompt.getState().answer(
        rest,
        action === 'deny'
          ? { decision: 'deny', scope: 'once', subdomains: false }
          : { decision: 'allow', scope: action === 'session' ? 'session' : 'once', subdomains: false }
      )
      return true
    case 'conflict': {
      const sessionId = prompt.threadId
      const request = sessionId ? useTeamConflictRequests.getState().bySession[sessionId] : undefined
      if (!sessionId || !request) return false
      if (action === 'cancel') {
        useTeamConflictRequests.getState().answer(sessionId, { kind: 'cancel' })
        return true
      }
      const decisions: Record<string, ConflictDecision> = {}
      for (const c of request.conflicts) {
        decisions[conflictKey(c)] =
          action === 'parallel' ? { kind: 'parallel' } : { kind: 'serialize', first: c.tasks[0], then: c.tasks[1] }
      }
      useTeamConflictRequests.getState().answer(sessionId, { kind: 'decided', decisions })
      return true
    }
    case 'context': {
      const modal = useContextSizeApproval.getState().modalProps
      if (!modal) return false
      if (action === 'ctx_len' || action === 'context_shift') modal.onApprove(action)
      else modal.onDeny()
      return true
    }
  }
}
