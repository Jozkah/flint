/**
 * Session-variable scope for MCP in each mode: the values a chat, cowork
 * session or room has, and whether its mode withholds the tools of template
 * servers it leaves unresolved.
 */
import type { MCPTool } from '@janhq/core'
import { useThreads } from '@/hooks/useThreads'
import { useToolApproval } from '@/hooks/useToolApproval'
import { useMcpPlaceholders } from '@/hooks/useMcpPlaceholders'
import {
  type McpSessionVars,
  normalizeVars,
  unresolvedNote,
  unresolvedServers,
  varsFromMetadata,
  withoutUnresolved,
} from '@/lib/mcpSessionVars'

/** A chat's variables, from its thread metadata. */
export function threadMcpVars(
  threadId: string | undefined
): McpSessionVars | undefined {
  if (!threadId) return undefined
  const thread = useThreads.getState().threads?.[threadId]
  return varsFromMetadata(thread?.metadata as Record<string, unknown> | undefined)
}

/** Save a chat's variables into its thread metadata. */
export function setThreadMcpVars(threadId: string, vars: McpSessionVars): void {
  const state = useThreads.getState()
  const thread = state.threads?.[threadId]
  if (!thread) return
  const metadata = { ...(thread.metadata ?? {}) } as Record<string, unknown>
  const clean = normalizeVars(vars)
  if (clean) metadata.mcpVariables = clean
  else delete metadata.mcpVariables
  state.updateThread(threadId, { metadata } as Parameters<typeof state.updateThread>[1])
}

/**
 * Chat withholds unresolved templates when calls are not asked about
 * (auto-approve, bypass): there would be no moment to ask for the values.
 */
export function chatWithholdsUnresolved(): boolean {
  return useToolApproval.getState().permissionMode !== 'ask'
}

/**
 * `tools` with the tools of unresolved templates removed when `withhold`,
 * and the model-facing note naming what was withheld.
 */
export function gateUnresolvedTools<T extends Pick<MCPTool, 'server'>>(
  tools: T[],
  vars: McpSessionVars | undefined,
  withhold: boolean
): { tools: T[]; note: string | null; withheld: Set<string> } {
  const none = { tools, note: null, withheld: new Set<string>() }
  if (!withhold) return none
  const placeholders = useMcpPlaceholders.getState().placeholders
  const unresolved = unresolvedServers(placeholders, vars)
  if (unresolved.size === 0) return none
  const present = new Set(tools.map((t) => t.server).filter(Boolean) as string[])
  const withheld = [...unresolved].filter((s) => present.has(s))
  return {
    tools: withoutUnresolved(tools, unresolved),
    note: unresolvedNote(withheld, placeholders, vars),
    // Every unresolved template, offered tools or not: none of them is
    // "enabled but listed nothing" for this session.
    withheld: unresolved,
  }
}
