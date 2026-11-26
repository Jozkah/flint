/**
 * Session-variable scope for MCP in Cowork: a session's `{{var}}` values and
 * whether its mode withholds the template servers they leave unresolved.
 * Kept apart from `mcpSessionScope` so the chat composer does not load the
 * cowork store.
 */
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { modeOf } from '@/lib/coworkMode'
import { type McpSessionVars, normalizeVars } from '@/lib/mcpSessionVars'

function coworkSession(sessionId: string | undefined) {
  if (!sessionId) return undefined
  return useCoworkSessions.getState().sessions.find((s) => s.id === sessionId)
}

/** A cowork session's variables. */
export function coworkMcpVars(
  sessionId: string | undefined
): McpSessionVars | undefined {
  return normalizeVars(coworkSession(sessionId)?.mcpVariables)
}

/** Save a cowork session's variables. */
export function setCoworkMcpVars(sessionId: string, vars: McpSessionVars): void {
  useCoworkSessions.getState().setMcpVariables(sessionId, normalizeVars(vars) ?? {})
}

/**
 * Cowork withholds unresolved templates in Auto and Bypass, which run calls
 * without stopping to ask.
 */
export function coworkWithholdsUnresolved(sessionId: string | undefined): boolean {
  const session = coworkSession(sessionId)
  if (!session) return true
  const mode = modeOf(session)
  return mode === 'auto' || mode === 'bypass'
}
