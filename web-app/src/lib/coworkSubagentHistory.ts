/**
 * What a finished subagent remembers, so the parent can send it a follow-up
 * instead of starting a stranger that has to be briefed again.
 *
 * In memory and per session: a subagent's conversation is part of the run that
 * started it, not a durable record, so it ends with the app or when the session
 * is deleted. The agent id is the dispatching `task` call's id and stays the
 * same across follow-ups.
 */
import type { UIMessage } from 'ai'

/** Finished subagents kept per session; the least recently used one goes first. */
export const MAX_REMEMBERED_SUBAGENTS = 24

export type RememberedSubagent = {
  /** The resolved definition name, so a follow-up runs as the same agent. */
  name: string
  messages: UIMessage[]
}

const bySession = new Map<string, Map<string, RememberedSubagent>>()

export function rememberSubagent(
  sessionId: string,
  agentId: string,
  entry: RememberedSubagent
): void {
  const agents = bySession.get(sessionId) ?? new Map<string, RememberedSubagent>()
  // Re-inserting moves it to the end, which is what "recently used" means here.
  agents.delete(agentId)
  agents.set(agentId, entry)
  while (agents.size > MAX_REMEMBERED_SUBAGENTS) {
    const oldest = agents.keys().next().value
    if (oldest === undefined) break
    agents.delete(oldest)
  }
  bySession.set(sessionId, agents)
}

export function recallSubagent(
  sessionId: string,
  agentId: string
): RememberedSubagent | undefined {
  return bySession.get(sessionId)?.get(agentId)
}

/** The ids a follow-up may name, most recent last. */
export function rememberedSubagentIds(sessionId: string): string[] {
  return [...(bySession.get(sessionId)?.keys() ?? [])]
}

export function forgetSessionSubagents(sessionId: string): void {
  bySession.delete(sessionId)
}

/** The line that tells the parent how to continue with this agent. */
export function resumeHint(agentId: string): string {
  return (
    `\n\n[agent_id: ${agentId}. To send this subagent a follow-up that keeps what ` +
    `it already knows, call task again with resume_agent_id: "${agentId}" and the ` +
    'follow-up as the description.]'
  )
}

export const __historyTesting = { reset: () => bySession.clear() }
