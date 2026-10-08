/**
 * Browser MCP Service - servers run on the Flint server.
 *
 * Trust grants, approval tickets and result budgets are enforced there, by the
 * same rules as the desktop app; this class only carries requests to them.
 */

import type { MCPTool, MCPToolCallResult } from '@janhq/core'
import { browserApi, jsonRequest } from '@/services/browserApi'
import { DEFAULT_MCP_SETTINGS } from '@/hooks/useMCPServers'
import type { MCPServerConfig, MCPServers, MCPSettings } from '@/hooks/useMCPServers'
import { DefaultMCPService } from './default'
import type {
  ListToolsOptions,
  MCPAuthStatus,
  MCPConfig,
  MCPForgetReason,
  MCPServerStatus,
  MCPTrustReport,
  ServerSummary,
  ToolCallWithCancellationResult,
} from './types'

const base = '/api/v1/mcp'
const server = (name: string) => `${base}/servers/${encodeURIComponent(name)}`

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

type CallArgs = {
  toolName: string
  serverName?: string
  arguments: object
  maxOutputChars?: number
  approvalTicket?: string
  cancellationToken?: string
}

export class BrowserMCPService extends DefaultMCPService {
  async updateMCPConfig(configs: string): Promise<void> {
    await browserApi<void>(`${base}/config`, jsonRequest('PUT', { configs }))
  }

  async restartMCPServers(): Promise<void> {
    await browserApi<void>(`${base}/restart`, { method: 'POST' })
  }

  async getMCPConfig(): Promise<MCPConfig> {
    const parsed = await browserApi<Record<string, unknown>>(`${base}/config`)
    const { mcpServers, mcpSettings, ...legacyServers } = parsed ?? {}
    const servers = isPlainObject(mcpServers)
      ? (mcpServers as MCPServers)
      : Object.keys(legacyServers).length > 0
        ? (legacyServers as MCPServers)
        : ({} as MCPServers)
    return {
      mcpServers: servers,
      mcpSettings: {
        ...DEFAULT_MCP_SETTINGS,
        ...(isPlainObject(mcpSettings) ? (mcpSettings as MCPSettings) : {}),
      },
    }
  }

  getTools(options?: ListToolsOptions): Promise<MCPTool[]> {
    return browserApi<MCPTool[]>(`${base}/tools${options?.start ? '?start=true' : ''}`)
  }

  getToolsForServers(serverNames: string[], options?: ListToolsOptions): Promise<MCPTool[]> {
    const query = new URLSearchParams({ servers: serverNames.join(',') })
    if (options?.start) query.set('start', 'true')
    return browserApi<MCPTool[]>(`${base}/tools?${query}`)
  }

  getServerSummaries(): Promise<ServerSummary[]> {
    return browserApi<ServerSummary[]>(`${base}/summaries`)
  }

  getServerLog(serverName: string, lines?: number): Promise<string[]> {
    const query = lines ? `?lines=${lines}` : ''
    return browserApi<string[]>(`${base}/log/${encodeURIComponent(serverName)}${query}`)
  }

  getConnectedServers(): Promise<string[]> {
    return browserApi<string[]>(`${base}/connected`)
  }

  callTool(args: CallArgs): Promise<MCPToolCallResult> {
    return browserApi<MCPToolCallResult>(`${base}/call`, jsonRequest('POST', args))
  }

  callToolWithCancellation(args: CallArgs): ToolCallWithCancellationResult {
    const token =
      args.cancellationToken ??
      `tool_call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
    return {
      promise: this.callTool({ ...args, cancellationToken: token }),
      cancel: () => this.cancelToolCall(token),
      token,
    }
  }

  async cancelToolCall(cancellationToken: string): Promise<void> {
    await browserApi<void>(`${base}/cancel`, jsonRequest('POST', { token: cancellationToken }))
  }

  trustedServers(): Promise<string[]> {
    return browserApi<string[]>(`${base}/trust/trusted`)
  }

  trustReport(): Promise<MCPTrustReport> {
    return browserApi<MCPTrustReport>(`${base}/trust`)
  }

  serverFingerprints(): Promise<Record<string, string>> {
    return browserApi<Record<string, string>>(`${base}/fingerprints`)
  }

  async trustServer(serverName: string, fingerprint?: string): Promise<void> {
    await browserApi<void>(
      `${base}/trust/${encodeURIComponent(serverName)}`,
      jsonRequest('POST', { fingerprint })
    )
  }

  async revokeServer(serverName: string): Promise<void> {
    await browserApi<void>(`${base}/trust/${encodeURIComponent(serverName)}`, { method: 'DELETE' })
  }

  async forgetServer(serverName: string, reason: MCPForgetReason): Promise<void> {
    await browserApi<void>(
      `${base}/forget/${encodeURIComponent(serverName)}`,
      jsonRequest('POST', { reason })
    )
  }

  async allowOnceForServer(
    serverName: string,
    toolName: string,
    fingerprint?: string
  ): Promise<string> {
    const result = await browserApi<{ ticket: string }>(
      `${base}/allow-once`,
      jsonRequest('POST', { serverName, toolName, fingerprint })
    )
    return result.ticket
  }

  async activateMCPServer(
    name: string,
    config: MCPServerConfig,
    options?: { start?: boolean }
  ): Promise<void> {
    await browserApi<void>(
      `${server(name)}/activate`,
      jsonRequest('POST', { config, start: options?.start ?? true })
    )
  }

  async deactivateMCPServer(name: string): Promise<void> {
    await browserApi<void>(`${server(name)}/deactivate`, { method: 'POST' })
  }

  async startMCPServer(name: string): Promise<void> {
    await browserApi<void>(`${server(name)}/start`, { method: 'POST' })
  }

  async stopMCPServer(name: string): Promise<void> {
    await browserApi<void>(`${server(name)}/stop`, { method: 'POST' })
  }

  getServerStatuses(): Promise<Record<string, MCPServerStatus>> {
    return browserApi<Record<string, MCPServerStatus>>(`${base}/statuses`)
  }

  async getMCPAuthStatus(name: string): Promise<MCPAuthStatus> {
    const status = await browserApi<MCPAuthStatus>(`${base}/auth/${encodeURIComponent(name)}`)
    // Sign-in needs a browser on the machine running the server.
    return { ...status, canAuthenticate: false }
  }

  async authorizeMCPServer(): Promise<void> {
    throw new Error(
      'Signing in to an MCP server needs a browser on the machine running Flint. Do it from the desktop app.'
    )
  }

  async clearMCPAuth(name: string): Promise<boolean> {
    const result = await browserApi<{ cleared: boolean }>(
      `${base}/auth/${encodeURIComponent(name)}`,
      { method: 'DELETE' }
    )
    return result.cleared
  }
}
