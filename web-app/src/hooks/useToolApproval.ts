import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import { getServiceHub } from '@/hooks/useServiceHub'

type ToolApprovalState = {
  /** threadId -> tool names trusted for that conversation only. */
  approvedTools: Record<string, string[]>
  /** MCP servers trusted in every conversation, tools included. */
  approvedServers: string[]
  /** Tools trusted in every conversation, for tools with no server. */
  approvedToolsGlobal: string[]
  allowAllMCPPermissions: boolean

  approveToolForThread: (threadId: string, toolName: string) => void
  /** Withdraw one conversation grant. Future calls in that thread prompt again. */
  revokeToolForThread: (threadId: string, toolName: string) => void
  /** Withdraw every grant a conversation holds. */
  revokeThread: (threadId: string) => void
  approveServer: (serverName: string) => void
  /**
   * Forget a server in the renderer store only.
   *
   * The backend gate keeps its own record; use {@link revokeServerTrust} from
   * any UI that means "stop trusting this server".
   */
  revokeServer: (serverName: string) => void
  /**
   * Stop trusting a server: backend first, then the store.
   *
   * Rejects, leaving the store untouched, when the backend refuses. Clearing
   * the store anyway would show the server as revoked while the gate that
   * actually enforces trust still lets its calls through.
   */
  revokeServerTrust: (serverName: string) => Promise<void>
  isServerApproved: (serverName: string) => boolean
  approveToolEverywhere: (toolName: string) => void
  /** Withdraw an every-conversation tool grant. */
  revokeToolEverywhere: (toolName: string) => void
  isToolApproved: (
    threadId: string,
    toolName: string,
    serverName?: string
  ) => boolean
  setAllowAllMCPPermissions: (allow: boolean) => void
  /** Turn off "allow every MCP tool without asking". */
  revokeAllowAllMCPPermissions: () => void
}

export const useToolApproval = create<ToolApprovalState>()(
  persist(
    (set, get) => ({
      approvedTools: {},
      approvedServers: [],
      approvedToolsGlobal: [],
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

      revokeThread: (threadId: string) => {
        set((state) => {
          if (!(threadId in state.approvedTools)) return state
          const next = { ...state.approvedTools }
          delete next[threadId]
          return { approvedTools: next }
        })
      },

      approveServer: (serverName: string) => {
        set((state) =>
          state.approvedServers.includes(serverName)
            ? state
            : { approvedServers: [...state.approvedServers, serverName] }
        )
      },

      revokeServer: (serverName: string) => {
        set((state) => ({
          approvedServers: state.approvedServers.filter(
            (s) => s !== serverName
          ),
        }))
      },

      revokeServerTrust: async (serverName: string) => {
        await getServiceHub().mcp().revokeServer(serverName)
        get().revokeServer(serverName)
      },

      isServerApproved: (serverName: string) => {
        return get().approvedServers.includes(serverName)
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
        serverName?: string
      ) => {
        const state = get()
        if (state.approvedToolsGlobal.includes(toolName)) return true
        if (serverName && state.approvedServers.includes(serverName)) {
          return true
        }
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
      // Only persist approved tools and global permission setting, not modal state
      partialize: (state) => ({
        approvedTools: state.approvedTools,
        approvedServers: state.approvedServers,
        approvedToolsGlobal: state.approvedToolsGlobal,
        allowAllMCPPermissions: state.allowAllMCPPermissions,
      }),
    }
  )
)
