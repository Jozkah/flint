import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import { getServiceHub } from '@/hooks/useServiceHub'
import type { MCPForgetReason } from '@/services/mcp/types'

/**
 * Approval state kept by the renderer.
 *
 * MCP approvals are bound to a server *and* its security fingerprint, which the
 * backend computes (`mcp_identity`). A name alone is not an identity: it can be
 * reused by a different program after a delete, or kept while the command or
 * endpoint behind it is edited. So an MCP grant here only answers for the exact
 * definition the user approved, mirroring the backend trust gate.
 *
 * Lifecycle, as the settings surfaces drive it:
 * - turn a server off: grants kept (same definition; its tools are unavailable)
 * - clear its authorization: grants kept (only OAuth tokens go)
 * - delete it: every grant for the name is removed ({@link forgetServer})
 * - rename it: grants for the old name are removed, nothing moves to the new one
 * - edit a security-relevant field: its fingerprint changes, so grants stop
 *   matching and are moved to {@link invalidatedServers} with a reason
 * - add a server with a name used before: it inherits nothing
 *
 * Grants for tools with no server (Flint's own tools) keep their original
 * name-keyed semantics.
 */

/** "Always allow this server", for one definition. */
export type McpServerGrant = { name: string; fingerprint: string }

/** "Allow this tool in this conversation", for one server definition. */
export type McpToolGrant = { server: string; tool: string; fingerprint: string }

export type InvalidatedApprovalReason =
  /** Recorded before approvals were bound to a server's configuration. */
  | 'legacy-approval'
  /** The server's configuration changed after it was approved. */
  | 'configuration-changed'

/** An approval that stopped applying, kept so the user can be told why. */
export type InvalidatedApproval = {
  name: string
  reason: InvalidatedApprovalReason
  /** ISO timestamp of when it was invalidated. */
  at: string
}

/** Persisted store version. Bump together with {@link migrateToolApproval}. */
export const TOOL_APPROVAL_STORE_VERSION = 1

export type PersistedToolApproval = {
  approvedTools: Record<string, string[]>
  approvedMcpTools: Record<string, McpToolGrant[]>
  approvedServers: McpServerGrant[]
  approvedToolsGlobal: string[]
  invalidatedServers: InvalidatedApproval[]
  allowAllMCPPermissions: boolean
}

type ToolApprovalState = PersistedToolApproval & {
  /** Grant a tool with no server in one conversation. */
  approveToolForThread: (threadId: string, toolName: string) => void
  /** Grant one server's tool, as currently defined, in one conversation. */
  approveMcpToolForThread: (
    threadId: string,
    serverName: string,
    toolName: string,
    fingerprint: string
  ) => void
  /** Withdraw one conversation grant. Future calls in that thread prompt again. */
  revokeToolForThread: (threadId: string, toolName: string) => void
  revokeMcpToolForThread: (
    threadId: string,
    serverName: string,
    toolName: string
  ) => void
  /** Withdraw every grant a conversation holds. */
  revokeThread: (threadId: string) => void
  /** Record that a server, as defined by `fingerprint`, is always allowed. */
  approveServer: (serverName: string, fingerprint: string) => void
  /**
   * Forget a server in the renderer store only.
   *
   * The backend gate keeps its own record; use {@link revokeServerTrust} from
   * any UI that means "stop trusting this server".
   */
  revokeServer: (serverName: string) => void
  /**
   * Trust a server: backend first, then the store. Rejects, leaving the store
   * untouched, when the backend refuses (for example because the server's
   * configuration no longer matches `fingerprint`).
   */
  approveServerTrust: (serverName: string, fingerprint: string) => Promise<void>
  /**
   * Stop trusting a server: backend first, then the store.
   *
   * Rejects, leaving the store untouched, when the backend refuses. Clearing
   * the store anyway would show the server as revoked while the gate that
   * actually enforces trust still lets its calls through.
   */
  revokeServerTrust: (serverName: string) => Promise<void>
  /** Whether the server, as defined by `fingerprint`, is always allowed. */
  isServerApproved: (serverName: string, fingerprint?: string) => boolean
  /**
   * Compare stored grants for a server with its current fingerprint. Grants
   * for a different definition are removed and listed as invalidated.
   */
  noteServerFingerprint: (serverName: string, fingerprint: string) => void
  /**
   * A server is being deleted or renamed: remove every renderer grant for the
   * name, then ask the backend to revoke its trust and clear its OAuth tokens.
   * The renderer part always happens; a backend failure is rethrown.
   */
  forgetServer: (serverName: string, reason: MCPForgetReason) => Promise<void>
  /** Remove a "needs renewing" notice. */
  dismissInvalidated: (serverName: string) => void
  approveToolEverywhere: (toolName: string) => void
  /** Withdraw an every-conversation tool grant. */
  revokeToolEverywhere: (toolName: string) => void
  /**
   * Whether a call is covered by a standing grant.
   *
   * For an MCP call (`serverName` given) only grants bound to that server and
   * `fingerprint` count; a name-only grant never answers for a server's tool,
   * and an unknown fingerprint matches nothing.
   */
  isToolApproved: (
    threadId: string,
    toolName: string,
    serverName?: string,
    fingerprint?: string
  ) => boolean
  setAllowAllMCPPermissions: (allow: boolean) => void
  /** Turn off "allow every MCP tool without asking". */
  revokeAllowAllMCPPermissions: () => void
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(isString).filter((v, i, all) => all.indexOf(v) === i)
    : []

const isServerGrant = (value: unknown): value is McpServerGrant =>
  isObject(value) && isString(value.name) && isString(value.fingerprint)

const isToolGrant = (value: unknown): value is McpToolGrant =>
  isObject(value) &&
  isString(value.server) &&
  isString(value.tool) &&
  isString(value.fingerprint)

const isInvalidated = (value: unknown): value is InvalidatedApproval =>
  isObject(value) &&
  isString(value.name) &&
  (value.reason === 'legacy-approval' ||
    value.reason === 'configuration-changed') &&
  typeof value.at === 'string'

/**
 * Bring persisted approval state to the current shape.
 *
 * Version 0 stored MCP server approvals as bare names. A name carries no
 * fingerprint, so there is no way to tell which definition the user approved:
 * those approvals are dropped rather than carried over, and listed in
 * `invalidatedServers` so the Permissions page can say they need renewing.
 * Conversation and every-conversation tool names are kept as they were; they
 * no longer answer for any MCP server's tool (see `isToolApproved`), which is
 * what invalidates the ones that were really MCP grants, while Flint's own tools
 * keep working unchanged.
 */
export function migrateToolApproval(
  persisted: unknown,
  version: number,
  now: () => string = () => new Date().toISOString()
): PersistedToolApproval {
  const source = isObject(persisted) ? persisted : {}

  const approvedTools: Record<string, string[]> = {}
  if (isObject(source.approvedTools)) {
    for (const [threadId, tools] of Object.entries(source.approvedTools)) {
      const list = stringList(tools)
      if (list.length) approvedTools[threadId] = list
    }
  }

  const approvedMcpTools: Record<string, McpToolGrant[]> = {}
  if (version >= 1 && isObject(source.approvedMcpTools)) {
    for (const [threadId, grants] of Object.entries(source.approvedMcpTools)) {
      const list = Array.isArray(grants) ? grants.filter(isToolGrant) : []
      if (list.length) approvedMcpTools[threadId] = list
    }
  }

  const rawServers = Array.isArray(source.approvedServers)
    ? source.approvedServers
    : []
  const approvedServers = rawServers.filter(isServerGrant)
  const invalidatedServers: InvalidatedApproval[] = Array.isArray(
    source.invalidatedServers
  )
    ? source.invalidatedServers.filter(isInvalidated)
    : []
  const at = now()
  for (const legacy of rawServers.filter(isString)) {
    if (approvedServers.some((grant) => grant.name === legacy)) continue
    if (invalidatedServers.some((entry) => entry.name === legacy)) continue
    invalidatedServers.push({ name: legacy, reason: 'legacy-approval', at })
  }

  return {
    approvedTools,
    approvedMcpTools,
    approvedServers,
    approvedToolsGlobal: stringList(source.approvedToolsGlobal),
    invalidatedServers,
    allowAllMCPPermissions: source.allowAllMCPPermissions === true,
  }
}

const withoutInvalidated = (
  list: InvalidatedApproval[],
  serverName: string
): InvalidatedApproval[] => list.filter((entry) => entry.name !== serverName)

export const useToolApproval = create<ToolApprovalState>()(
  persist(
    (set, get) => ({
      approvedTools: {},
      approvedMcpTools: {},
      approvedServers: [],
      approvedToolsGlobal: [],
      invalidatedServers: [],
      allowAllMCPPermissions: false,

      approveToolForThread: (threadId: string, toolName: string) => {
        set((state) => ({
          approvedTools: {
            ...state.approvedTools,
            [threadId]: [
              ...(state.approvedTools[threadId] || []),
              toolName,
            ].filter((tool, index, arr) => arr.indexOf(tool) === index), // Remove duplicates
          },
        }))
      },

      approveMcpToolForThread: (threadId, serverName, toolName, fingerprint) => {
        set((state) => {
          const current = state.approvedMcpTools[threadId] ?? []
          const others = current.filter(
            (grant) => !(grant.server === serverName && grant.tool === toolName)
          )
          return {
            approvedMcpTools: {
              ...state.approvedMcpTools,
              [threadId]: [
                ...others,
                { server: serverName, tool: toolName, fingerprint },
              ],
            },
          }
        })
      },

      revokeToolForThread: (threadId: string, toolName: string) => {
        set((state) => {
          const current = state.approvedTools[threadId]
          if (!current?.includes(toolName)) return state
          const remaining = current.filter((tool) => tool !== toolName)
          const next = { ...state.approvedTools }
          // An empty list is dropped rather than kept, so the settings page
          // does not list a conversation that no longer holds anything.
          if (remaining.length) next[threadId] = remaining
          else delete next[threadId]
          return { approvedTools: next }
        })
      },

      revokeMcpToolForThread: (threadId, serverName, toolName) => {
        set((state) => {
          const current = state.approvedMcpTools[threadId]
          if (!current) return state
          const remaining = current.filter(
            (grant) => !(grant.server === serverName && grant.tool === toolName)
          )
          if (remaining.length === current.length) return state
          const next = { ...state.approvedMcpTools }
          if (remaining.length) next[threadId] = remaining
          else delete next[threadId]
          return { approvedMcpTools: next }
        })
      },

      revokeThread: (threadId: string) => {
        set((state) => {
          if (
            !(threadId in state.approvedTools) &&
            !(threadId in state.approvedMcpTools)
          ) {
            return state
          }
          const tools = { ...state.approvedTools }
          const mcpTools = { ...state.approvedMcpTools }
          delete tools[threadId]
          delete mcpTools[threadId]
          return { approvedTools: tools, approvedMcpTools: mcpTools }
        })
      },

      approveServer: (serverName: string, fingerprint: string) => {
        if (!fingerprint) return
        set((state) => {
          if (
            state.approvedServers.some(
              (grant) =>
                grant.name === serverName && grant.fingerprint === fingerprint
            )
          ) {
            return state
          }
          return {
            approvedServers: [
              ...state.approvedServers.filter(
                (grant) => grant.name !== serverName
              ),
              { name: serverName, fingerprint },
            ],
            invalidatedServers: withoutInvalidated(
              state.invalidatedServers,
              serverName
            ),
          }
        })
      },

      revokeServer: (serverName: string) => {
        set((state) => ({
          approvedServers: state.approvedServers.filter(
            (grant) => grant.name !== serverName
          ),
        }))
      },

      approveServerTrust: async (serverName: string, fingerprint: string) => {
        await getServiceHub().mcp().trustServer(serverName, fingerprint)
        get().approveServer(serverName, fingerprint)
      },

      revokeServerTrust: async (serverName: string) => {
        await getServiceHub().mcp().revokeServer(serverName)
        get().revokeServer(serverName)
        get().dismissInvalidated(serverName)
      },

      isServerApproved: (serverName: string, fingerprint?: string) => {
        if (!fingerprint) return false
        return get().approvedServers.some(
          (grant) =>
            grant.name === serverName && grant.fingerprint === fingerprint
        )
      },

      noteServerFingerprint: (serverName: string, fingerprint: string) => {
        if (!fingerprint) return
        set((state) => {
          const staleServer = state.approvedServers.some(
            (grant) =>
              grant.name === serverName && grant.fingerprint !== fingerprint
          )
          let staleTool = false
          const approvedMcpTools: Record<string, McpToolGrant[]> = {}
          for (const [threadId, grants] of Object.entries(
            state.approvedMcpTools
          )) {
            const kept = grants.filter((grant) => {
              const stale =
                grant.server === serverName && grant.fingerprint !== fingerprint
              if (stale) staleTool = true
              return !stale
            })
            if (kept.length) approvedMcpTools[threadId] = kept
          }
          if (!staleServer && !staleTool) return state
          return {
            approvedServers: state.approvedServers.filter(
              (grant) => grant.name !== serverName
            ),
            approvedMcpTools,
            invalidatedServers: [
              ...withoutInvalidated(state.invalidatedServers, serverName),
              {
                name: serverName,
                reason: 'configuration-changed' as const,
                at: new Date().toISOString(),
              },
            ],
          }
        })
      },

      forgetServer: async (serverName: string, reason: MCPForgetReason) => {
        set((state) => {
          const approvedMcpTools: Record<string, McpToolGrant[]> = {}
          for (const [threadId, grants] of Object.entries(
            state.approvedMcpTools
          )) {
            const kept = grants.filter((grant) => grant.server !== serverName)
            if (kept.length) approvedMcpTools[threadId] = kept
          }
          return {
            approvedServers: state.approvedServers.filter(
              (grant) => grant.name !== serverName
            ),
            approvedMcpTools,
            invalidatedServers: withoutInvalidated(
              state.invalidatedServers,
              serverName
            ),
          }
        })
        await getServiceHub().mcp().forgetServer(serverName, reason)
      },

      dismissInvalidated: (serverName: string) => {
        set((state) =>
          state.invalidatedServers.some((entry) => entry.name === serverName)
            ? {
                invalidatedServers: withoutInvalidated(
                  state.invalidatedServers,
                  serverName
                ),
              }
            : state
        )
      },

      approveToolEverywhere: (toolName: string) => {
        set((state) =>
          state.approvedToolsGlobal.includes(toolName)
            ? state
            : { approvedToolsGlobal: [...state.approvedToolsGlobal, toolName] }
        )
      },

      revokeToolEverywhere: (toolName: string) => {
        set((state) =>
          state.approvedToolsGlobal.includes(toolName)
            ? {
                approvedToolsGlobal: state.approvedToolsGlobal.filter(
                  (tool) => tool !== toolName
                ),
              }
            : state
        )
      },

      isToolApproved: (
        threadId: string,
        toolName: string,
        serverName?: string,
        fingerprint?: string
      ) => {
        const state = get()
        if (serverName) {
          if (!fingerprint) return false
          if (
            state.approvedServers.some(
              (grant) =>
                grant.name === serverName && grant.fingerprint === fingerprint
            )
          ) {
            return true
          }
          return (
            state.approvedMcpTools[threadId]?.some(
              (grant) =>
                grant.server === serverName &&
                grant.tool === toolName &&
                grant.fingerprint === fingerprint
            ) ?? false
          )
        }
        if (state.approvedToolsGlobal.includes(toolName)) return true
        return state.approvedTools[threadId]?.includes(toolName) || false
      },

      setAllowAllMCPPermissions: (allow: boolean) => {
        set({ allowAllMCPPermissions: allow })
      },

      revokeAllowAllMCPPermissions: () => {
        set({ allowAllMCPPermissions: false })
      },
    }),
    {
      name: localStorageKey.toolApproval,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      version: TOOL_APPROVAL_STORE_VERSION,
      migrate: (persisted, version) => migrateToolApproval(persisted, version),
      // Only persist approvals and the global permission setting, not modal state
      partialize: (state) => ({
        approvedTools: state.approvedTools,
        approvedMcpTools: state.approvedMcpTools,
        approvedServers: state.approvedServers,
        approvedToolsGlobal: state.approvedToolsGlobal,
        invalidatedServers: state.invalidatedServers,
        allowAllMCPPermissions: state.allowAllMCPPermissions,
      }),
    }
  )
)
