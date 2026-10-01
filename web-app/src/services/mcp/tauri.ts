/**
 * Tauri MCP Service - Desktop implementation
 */

import { invoke } from '@tauri-apps/api/core'
import { MCPTool } from '@/types/completion'
import { DEFAULT_MCP_SETTINGS } from '@/hooks/useMCPServers'
import type { MCPServerConfig, MCPServers, MCPSettings } from '@/hooks/useMCPServers'
import type {
  MCPAuthStatus,
  ListToolsOptions,
  MCPConfig,
  MCPForgetReason,
  MCPServerStatus,
  MCPTrustReport,
  ServerSummary,
} from './types'
import { DefaultMCPService } from './default'
import { recordToolCall } from '@/stores/engine-activity-store'

/**
 * Counts a finished call for the Tools & MCP page's per-server charts. The
 * original promise is returned untouched, so callers see exactly what they
 * saw before; the tally only observes it.
 */
function tallied<T>(
  args: { toolName: string; serverName?: string },
  promise: Promise<T> | undefined
): Promise<T> {
  if (!promise || typeof promise.then !== 'function') return promise as Promise<T>
  promise.then(
    (result) =>
      recordToolCall({
        server: args.serverName ?? '',
        tool: args.toolName,
        ok: !(result as { error?: string } | undefined)?.error,
      }),
    () =>
      recordToolCall({
        server: args.serverName ?? '',
        tool: args.toolName,
        ok: false,
      })
  )
  return promise
}

export class TauriMCPService extends DefaultMCPService {
  async updateMCPConfig(configs: string): Promise<void> {
    await window.core?.api?.saveMcpConfigs({ configs })
  }

  async restartMCPServers(): Promise<void> {
    await window.core?.api?.restartMcpServers()
  }

  async getMCPConfig(): Promise<MCPConfig> {
    const rawConfig = await window.core?.api?.getMcpConfigs()
    const configString = typeof rawConfig === 'string' ? rawConfig.trim() : ''

    const defaultResponse = (): MCPConfig => ({
      mcpServers: {},
      mcpSettings: { ...DEFAULT_MCP_SETTINGS },
    })

    if (!configString) {
      return defaultResponse()
    }

    let parsed: MCPConfig & Record<string, unknown>
    try {
      parsed = JSON.parse(configString) as MCPConfig & Record<string, unknown>
    } catch (error) {
      console.error('Failed to parse MCP config JSON; falling back to defaults:', error)
      return defaultResponse()
    }

    if (!parsed || typeof parsed !== 'object') {
      return defaultResponse()
    }

    const { mcpServers, mcpSettings, ...legacyServers } = parsed
    const hasLegacyServers = Object.keys(legacyServers).length > 0

    const normalizedServers: MCPServers =
      (isPlainObject(mcpServers) ? (mcpServers as MCPServers) : undefined) ??
      (hasLegacyServers && isPlainObject(legacyServers)
        ? (legacyServers as MCPServers)
        : ({} as MCPServers))

    const normalizedSettings: MCPSettings = {
      ...DEFAULT_MCP_SETTINGS,
      ...(isPlainObject(mcpSettings) ? (mcpSettings as MCPSettings) : {}),
    }

    return {
      mcpServers: normalizedServers,
      mcpSettings: normalizedSettings,
    }
  }

  async getTools(options?: ListToolsOptions): Promise<MCPTool[]> {
    // Plain listings stay on the existing bridge; a listing that may start
    // servers on demand passes the flag through.
    if (options?.start) return invoke('get_tools', { start: true })
    return window.core?.api?.getTools()
  }

  async getToolsForServers(
    serverNames: string[],
    options?: ListToolsOptions
  ): Promise<MCPTool[]> {
    if (options?.start) {
      return invoke('get_tools_for_servers', { serverNames, start: true })
    }
    return invoke('get_tools_for_servers', { serverNames })
  }

  async getServerSummaries(): Promise<ServerSummary[]> {
    return invoke('get_server_summaries')
  }

  async getServerLog(serverName: string, lines?: number): Promise<string[]> {
    return invoke('get_mcp_server_log', { name: serverName, lines })
  }

  async getConnectedServers(): Promise<string[]> {
    return window.core?.api?.getConnectedServers()
  }

  async callTool(args: {
    toolName: string
    serverName?: string
    arguments: object
    maxOutputChars?: number
    approvalTicket?: string
  }): Promise<{ error: string; content: { text: string }[] }> {
    return tallied(args, window.core?.api?.callTool(args))
  }

  async trustedServers(): Promise<string[]> {
    return invoke('mcp_trusted_servers')
  }

  async trustReport(): Promise<MCPTrustReport> {
    return invoke('mcp_trust_report')
  }

  async serverFingerprints(): Promise<Record<string, string>> {
    return invoke('mcp_server_fingerprints')
  }

  async trustServer(serverName: string, fingerprint?: string): Promise<void> {
    await invoke('mcp_trust_server', { serverName, fingerprint })
  }

  async revokeServer(serverName: string): Promise<void> {
    await invoke('mcp_revoke_server', { serverName })
  }

  async forgetServer(
    serverName: string,
    reason: MCPForgetReason
  ): Promise<void> {
    await invoke('mcp_forget_server', { serverName, reason })
  }

  async allowOnceForServer(
    serverName: string,
    toolName: string,
    fingerprint?: string
  ): Promise<string> {
    return invoke('mcp_allow_once', { serverName, toolName, fingerprint })
  }

  callToolWithCancellation(args: {
    toolName: string
    serverName?: string
    arguments: object
    cancellationToken?: string
  }): {
    promise: Promise<{ error: string; content: { text: string }[] }>
    cancel: () => Promise<void>
    token: string
  } {
    // Generate a unique cancellation token if not provided
    const token = args.cancellationToken ?? `tool_call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    // Create the tool call promise with cancellation token
    const promise = tallied<{ error: string; content: { text: string }[] }>(
      args,
      window.core?.api?.callTool({
        ...args,
        cancellationToken: token
      })
    )

    // Create cancel function
    const cancel = async () => {
      await window.core?.api?.cancelToolCall({ cancellationToken: token })
    }

    return { promise, cancel, token }
  }

  async cancelToolCall(cancellationToken: string): Promise<void> {
    return await window.core?.api?.cancelToolCall({ cancellationToken })
  }

  async activateMCPServer(
    name: string,
    config: MCPServerConfig,
    options?: { start?: boolean }
  ): Promise<void> {
    if (options?.start === false) {
      return await invoke('activate_mcp_server', { name, config, start: false })
    }
    return await invoke('activate_mcp_server', { name, config })
  }

  async startMCPServer(name: string): Promise<void> {
    await invoke('start_mcp_server_now', { name })
  }

  async stopMCPServer(name: string): Promise<void> {
    await invoke('stop_mcp_server_now', { name })
  }

  async getServerStatuses(): Promise<Record<string, MCPServerStatus>> {
    return (await invoke('get_mcp_server_statuses')) ?? {}
  }

  async deactivateMCPServer(name: string): Promise<void> {
    return await invoke('deactivate_mcp_server', { name })
  }

  async checkJanBrowserExtensionConnected(): Promise<boolean> {
    return await invoke('check_jan_browser_extension_connected')
  }

  async getMCPAuthStatus(name: string): Promise<MCPAuthStatus> {
    return await invoke('get_mcp_auth_status', { name })
  }

  async authorizeMCPServer(name: string): Promise<void> {
    return await invoke('authorize_mcp_server', { name })
  }

  async clearMCPAuth(name: string): Promise<boolean> {
    return await invoke('clear_mcp_auth', { name })
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
