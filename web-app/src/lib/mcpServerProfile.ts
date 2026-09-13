import type { MCPServerConfig } from '@/hooks/useMCPServers'
import type { MCPAuthStatus } from '@/services/mcp/types'
import { classifyModelLocation } from '@/lib/modelLocation'

/**
 * What an MCP server is, in the terms a person deciding whether to turn it on
 * needs: where it runs, whether it reaches outside this computer, what it is
 * given access to, and what has to happen before it works.
 *
 * Everything here is derived from the saved configuration and the auth status
 * the backend reports. Nothing is inferred about what a server *does*: a stdio
 * server is an arbitrary program, so whether it uses the network is answered
 * "depends", never "no".
 *
 * Secrets never leave this function: header and environment variable *names*
 * are reported, their values are not.
 */

export type McpTransport = 'stdio' | 'http' | 'sse'

export type McpRunsWhere =
  /** stdio: a program started on this computer with the user's permissions. */
  | 'local-process'
  /** http/sse to loopback or a private network address. */
  | 'local-endpoint'
  /** http/sse to a public host. */
  | 'remote-service'
  /**
   * http/sse to a single-label name (`http://nas:8080`) or an unparseable URL:
   * whether that is on this network depends on the resolver, so it is not
   * claimed either way.
   */
  | 'unresolved-endpoint'

/**
 * Whether using this server can involve services beyond this computer and
 * network. `depends` whenever JAN cannot see what the server itself does.
 */
export type McpContactsExternal = 'yes' | 'depends'

export type McpAccessItem =
  | { kind: 'runs-command'; command: string; args: string[] }
  | { kind: 'env-vars'; names: string[] }
  | { kind: 'sends-headers'; names: string[] }
  | { kind: 'connects-to'; host: string }

export type McpSetupRequirement =
  | { kind: 'authorization'; state: MCPAuthStatus['state'] }
  | { kind: 'browser-extension' }
  | { kind: 'missing-command' }
  | { kind: 'missing-url' }

export type McpServerProfile = {
  transport: McpTransport
  runsWhere: McpRunsWhere
  /** The host an http/sse server is reached at; null for stdio. */
  host: string | null
  contactsExternalServices: McpContactsExternal
  requiredAccess: McpAccessItem[]
  /**
   * Where its tools can be used. Verified against `custom-chat-transport`:
   * MCP tools are loaded for every chat whose selected model supports tools,
   * and the per-tool on/off switches are global, not per chat.
   */
  appliesTo: 'chats-with-tool-capable-models'
  setupRequirements: McpSetupRequirement[]
  description: string | null
}

/** Auth states that block a connection until the user signs in (or renews). */
const AUTH_BLOCKING_STATES: ReadonlySet<MCPAuthStatus['state']> = new Set([
  'unauthenticated',
  'expired',
  'staleResource',
])

export function needsAuthorization(status: MCPAuthStatus | undefined): boolean {
  return (
    !!status && status.canAuthenticate && AUTH_BLOCKING_STATES.has(status.state)
  )
}

export function transportOf(config: Pick<MCPServerConfig, 'type'>): McpTransport {
  return config.type === 'http' || config.type === 'sse' ? config.type : 'stdio'
}

function hostOf(url: string | undefined): string | null {
  if (!url?.trim()) return null
  try {
    return new URL(url.trim()).hostname || null
  } catch {
    return null
  }
}

function nonEmptyKeys(record: Record<string, string> | undefined): string[] {
  return Object.keys(record ?? {}).filter((k) => k.trim() !== '')
}

export function deriveMcpServerProfile(
  config: MCPServerConfig,
  authStatus?: MCPAuthStatus
): McpServerProfile {
  const transport = transportOf(config)
  const requiredAccess: McpAccessItem[] = []
  const setupRequirements: McpSetupRequirement[] = []
  const description = config.description?.trim() || null

  if (transport === 'stdio') {
    const command = config.command?.trim() ?? ''
    if (command) {
      requiredAccess.push({
        kind: 'runs-command',
        command,
        args: (config.args ?? []).filter((a) => a.trim() !== ''),
      })
    } else {
      setupRequirements.push({ kind: 'missing-command' })
    }
    const envNames = nonEmptyKeys(config.env)
    if (envNames.length > 0) {
      requiredAccess.push({ kind: 'env-vars', names: envNames })
    }
    if (config.official) setupRequirements.push({ kind: 'browser-extension' })

    return {
      transport,
      runsWhere: 'local-process',
      host: null,
      // The program runs with the user's permissions and may open any
      // connection it likes; JAN has no way to see or limit that.
      contactsExternalServices: 'depends',
      requiredAccess,
      appliesTo: 'chats-with-tool-capable-models',
      setupRequirements,
      description,
    }
  }

  const host = hostOf(config.url)
  if (!config.url?.trim()) setupRequirements.push({ kind: 'missing-url' })

  const location = classifyModelLocation({ baseUrl: config.url })
  const runsWhere: McpRunsWhere =
    location === 'local'
      ? 'local-endpoint'
      : location === 'remote'
        ? 'remote-service'
        : 'unresolved-endpoint'

  if (host) requiredAccess.push({ kind: 'connects-to', host })
  const headerNames = nonEmptyKeys(config.headers)
  if (headerNames.length > 0) {
    requiredAccess.push({ kind: 'sends-headers', names: headerNames })
  }
  if (needsAuthorization(authStatus)) {
    setupRequirements.push({ kind: 'authorization', state: authStatus!.state })
  }

  return {
    transport,
    runsWhere,
    host,
    // A remote service is, by definition, external. A local endpoint keeps the
    // connection on this network, but the server behind it may call out.
    contactsExternalServices: runsWhere === 'remote-service' ? 'yes' : 'depends',
    requiredAccess,
    appliesTo: 'chats-with-tool-capable-models',
    setupRequirements,
    description,
  }
}
