/**
 * MCP Service Types
 */

import { MCPTool, MCPToolCallResult } from '@janhq/core'
import type { MCPServerConfig, MCPServers, MCPSettings } from '@/hooks/useMCPServers'

export interface MCPConfig {
  mcpServers?: MCPServers
  mcpSettings?: MCPSettings
}

export interface ToolCallWithCancellationResult {
  promise: Promise<MCPToolCallResult>
  cancel: () => Promise<void>
  token: string
}

/** Lightweight server metadata used by the orchestrator for tool routing. */
export interface ServerSummary {
  name: string
  capabilities: string[]
  description: string
}

/**
 * OAuth state of one remote MCP server, as reported by `get_mcp_auth_status`.
 * Derived entirely on the Rust side so the UI never re-implements the rules
 * (a hand-written `Authorization` header, for instance, means OAuth is neither
 * offered nor reported as missing).
 */
export interface MCPAuthStatus {
  state:
    | 'notApplicable'
    | 'staticHeader'
    | 'authenticated'
    | 'expired'
    | 'staleResource'
    | 'scopeMismatch'
    | 'invalidScopes'
    | 'unauthenticated'
  /** Whether an interactive sign-in is possible and would mean something. */
  canAuthenticate: boolean
  /** Whether there are stored tokens to forget. */
  hasCredentials: boolean
  /**
   * Whether a stored refresh token can renew this without the browser. Only
   * meaningful for `expired`; false everywhere else.
   */
  renewable: boolean
  /** Unix seconds the access token expires at, when known. */
  expiresAt: number | null
  /** What the server's configuration declares: what a sign-in asks for (AH-135). */
  declaredScopes: string[]
  /** What the stored token was asked for under. */
  requestedScopes: string[]
  /** What the provider granted the stored token; never wider than requested. */
  grantedScopes: string[]
  /** Why the state is what it is, when that is not obvious from the state. */
  detail: string | null
}

export interface MCPService {
  updateMCPConfig(configs: string): Promise<void>
  restartMCPServers(): Promise<void>
  getMCPConfig(): Promise<MCPConfig>
  getTools(): Promise<MCPTool[]>
  /** Fetch tools from a specific subset of servers. */
  getToolsForServers(serverNames: string[]): Promise<MCPTool[]>
  /** Return name/capabilities/description for all connected servers. */
  getServerSummaries(): Promise<ServerSummary[]>
  /** One server's own stderr log, scrubbed and bounded, newest last (AH-140). */
  getServerLog(serverName: string, lines?: number): Promise<string[]>
  getConnectedServers(): Promise<string[]>
  /**
   * `maxOutputChars` is a per-result character budget derived from the active
   * model's context window; the backend narrows its own configured cap to it so
   * one oversized result cannot exhaust the context.
   */
  callTool(args: {
    toolName: string
    serverName?: string
    arguments: object
    maxOutputChars?: number
    /**
     * A single-use authorization from `allowOnceForServer`, required by the
     * backend for a server the user has not trusted outright. AH-041.
     */
    approvalTicket?: string
  }): Promise<MCPToolCallResult>
  /** Servers the user has trusted, as the backend records them. AH-041. */
  trustedServers(): Promise<string[]>
  /** Record that the user trusts a server in every conversation. AH-041. */
  trustServer(serverName: string): Promise<void>
  /** Withdraw trust from a server. AH-041. */
  revokeServer(serverName: string): Promise<void>
  /**
   * Authorize one call to one tool on one server, returning the ticket the
   * backend will consume. AH-041.
   */
  allowOnceForServer(serverName: string, toolName: string): Promise<string>
  callToolWithCancellation(args: {
    toolName: string
    serverName?: string
    arguments: object
    cancellationToken?: string
  }): ToolCallWithCancellationResult
  cancelToolCall(cancellationToken: string): Promise<void>

  // MCP Server lifecycle management
  activateMCPServer(name: string, config: MCPServerConfig): Promise<void>
  deactivateMCPServer(name: string): Promise<void>
  checkJanBrowserExtensionConnected(): Promise<boolean>

  // OAuth for remote (http/sse) servers
  /** Local read, no network: safe to call per row. */
  getMCPAuthStatus(name: string): Promise<MCPAuthStatus>
  /**
   * Run the full interactive authorization. Resolves only once the browser
   * redirect has been exchanged for tokens, so expect this to be pending for as
   * long as the user takes (the backend gives up after five minutes).
   */
  authorizeMCPServer(name: string): Promise<void>
  /** Forget stored tokens. `false` when there were none. */
  clearMCPAuth(name: string): Promise<boolean>
}
