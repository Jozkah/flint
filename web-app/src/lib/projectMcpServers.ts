import { useMCPServers } from '@/hooks/useMCPServers'
import { useThreadManagementStore } from '@/hooks/useThreadManagement'
import { useThreads } from '@/hooks/useThreads'

/**
 * The MCP servers a project lets its chats use, or `null` when it uses every
 * enabled server (the default, and always the case outside a project).
 * Servers removed from the global config are dropped silently. Servers keep
 * running globally: this only filters which tools a chat is offered.
 */
export function projectMcpAllowList(
  projectId: string | undefined
): Set<string> | null {
  if (!projectId) return null
  const folder = useThreadManagementStore
    .getState()
    .folders.find((f) => f.id === projectId)
  if (!folder || !Array.isArray(folder.mcpServers)) return null
  const configured = useMCPServers.getState().mcpServers ?? {}
  return new Set(folder.mcpServers.filter((name) => name in configured))
}

export function threadProjectId(
  threadId: string | undefined
): string | undefined {
  if (!threadId) return undefined
  return useThreads.getState().threads[threadId]?.metadata?.project?.id
}

/** The allow list for a chat, by its thread. `null` = no filter. */
export function threadMcpAllowList(
  threadId: string | undefined
): Set<string> | null {
  return projectMcpAllowList(threadProjectId(threadId))
}

export function filterToolsByServers<T extends { server?: string }>(
  tools: T[],
  allow: Set<string> | null
): T[] {
  if (!allow) return tools
  return tools.filter((tool) => allow.has(tool.server || 'unknown'))
}
