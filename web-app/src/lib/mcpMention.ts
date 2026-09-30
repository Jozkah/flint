import { toast } from 'sonner'
import { i18n } from '@/i18n/react-i18next-compat'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useMCPServers, type MCPServers } from '@/hooks/useMCPServers'
import { mentionedServers } from '@/lib/mcp-orchestrator/intent-classifier'

/**
 * Asking for an MCP server that is off.
 *
 * Tool routing only ever sees servers that are connected, so naming a server
 * that is disabled or stopped matched nothing and the model just went without
 * its tools. This notices the mention on send and offers to turn the server on.
 *
 * It never enables anything by itself: starting a server runs its command (or
 * connects to its URL), which is the user's decision. It is also not a gate on
 * the message, which is sent as it is; a server started now is there for the
 * next one.
 */

/** Names the user already said no to (or was asked about), for this session. */
const asked = new Set<string>()

/** Forget who was asked, for tests. */
export function resetMcpMentionMemory(): void {
  asked.clear()
}

/**
 * Configured servers that the message names and that are not connected.
 * Uses the same naming rule as tool routing, so "use the notion server" and
 * "ida-multi-mcp tools" count while a bare ordinary word does not.
 */
export function offServersMentioned(
  text: string,
  servers: MCPServers,
  connected: readonly string[]
): string[] {
  const running = new Set(connected)
  const off = Object.keys(servers).filter((name) => !running.has(name))
  if (off.length === 0) return []
  return mentionedServers(
    text,
    off.map((name) => ({ name, capabilities: [], description: '' }))
  )
}

/**
 * Turn a server on and confirm it is really up, as Settings does: the start
 * returning is not enough, only the backend's connected list is.
 */
export async function enableMcpServer(name: string): Promise<void> {
  const store = useMCPServers.getState()
  const config = store.getServerConfig(name)
  if (!config) throw new Error(`No MCP server named ${name}`)
  const mcp = getServiceHub().mcp()
  await mcp.activateMCPServer(name, { ...config, active: true })
  const connected = await mcp.getConnectedServers()
  if (!connected.includes(name)) {
    void Promise.resolve(mcp.deactivateMCPServer(name)).catch(() => {})
    throw new Error(i18n.t('mcp-servers:connection.notListedAfterStart'))
  }
  store.editServer(name, { ...config, active: true })
  await store.syncServers()
}

/**
 * On send: offer to enable each server the message names that is off. Fire and
 * forget; never throws, never blocks the send.
 */
export async function offerToEnableMentionedServers(text: string): Promise<void> {
  try {
    if (!text.trim() || text.trimStart().startsWith('/')) return
    const servers = useMCPServers.getState().mcpServers
    if (Object.keys(servers).length === 0) return
    const connected = await getServiceHub().mcp().getConnectedServers()
    for (const name of offServersMentioned(text, servers, connected)) {
      if (asked.has(name)) continue
      asked.add(name)
      toast(i18n.t('mcp-servers:mention.offTitle', { serverName: name }), {
        description: i18n.t('mcp-servers:mention.offDesc'),
        duration: 15_000,
        action: {
          label: i18n.t('mcp-servers:mention.enable'),
          onClick: () => {
            enableMcpServer(name).then(
              () =>
                toast.success(i18n.t('mcp-servers:mention.enabled', { serverName: name })),
              (error: unknown) =>
                toast.error(
                  i18n.t('mcp-servers:mention.failed', {
                    serverName: name,
                    error: error instanceof Error ? error.message : String(error),
                  })
                )
            )
          },
        },
      })
    }
  } catch {
    // A courtesy, never a reason to disturb the send.
  }
}
