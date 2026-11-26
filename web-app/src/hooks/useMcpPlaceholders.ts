import { create } from 'zustand'
import { getServiceHub } from '@/hooks/useServiceHub'
import type { McpPlaceholders } from '@/lib/mcpSessionVars'

type State = {
  /** The `{{var}}` names each enabled template server uses. */
  placeholders: McpPlaceholders
  /** Re-read them from the backend (on load and on every `mcp-update`). */
  refresh: () => Promise<McpPlaceholders>
}

let latest = 0

export const useMcpPlaceholders = create<State>()((set, get) => ({
  placeholders: {},
  refresh: async () => {
    const mine = ++latest
    try {
      const placeholders =
        (await getServiceHub().mcp().getSessionPlaceholders?.()) ?? {}
      if (mine === latest) set({ placeholders })
      return placeholders
    } catch (error) {
      console.warn('Failed to read MCP session placeholders:', error)
      return get().placeholders
    }
  },
}))
