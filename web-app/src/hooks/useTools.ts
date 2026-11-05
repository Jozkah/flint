import { useEffect } from 'react'
import { getServiceHub } from '@/hooks/useServiceHub'
import { SystemEvent } from '@/types/events'
import { useAppState } from './useAppState'
import { useToolAvailable } from './useToolAvailable'
import { ExtensionManager } from '@/lib/extension'
import { ExtensionTypeEnum, MCPExtension } from '@janhq/core'
import { mcpOrchestrator } from '@/lib/mcp-orchestrator/mcp-orchestrator'
import { bumpMcpGeneration } from '@/lib/mcpLiveTools'

type Handlers = {
  updateTools: ReturnType<typeof useAppState.getState>['updateTools']
  updateRagToolNames: ReturnType<typeof useAppState.getState>['updateRagToolNames']
  updateMcpToolNames: ReturnType<typeof useAppState.getState>['updateMcpToolNames']
  isDefaultsInitialized: () => boolean
  setDisabledTools: (tools: string[]) => void
  markDefaultsAsInitialized: () => void
}

// One fetch and one MCP_UPDATE listener shared by every mounted useTools
// (composer, conversation, home route, split panes), ref-counted so the
// listener lives while at least one consumer is mounted.
let mounts = 0
let stopShared: (() => void) | undefined
let current: Handlers | undefined

function startShared(): () => void {
  // Only the newest call may write: a slow older one must not overwrite it.
  let latest = 0
  async function setTools() {
    const mine = ++latest
    const h = current!
    try {
      // A server connect/disconnect/tools-refresh fired this (mcp-update);
      // the orchestrator's per-request tool cache would otherwise only
      // notice via its own TTL, serving stale/reordered tools in the
      // meantime and destabilizing the KV-cache prefix Flint sends.
      mcpOrchestrator.invalidateCache()
      // Chats and Cowork re-read the tool set at their next request.
      bumpMcpGeneration()

      // Get MCP extension first
      const mcpExtension = ExtensionManager.getInstance().get<MCPExtension>(
        ExtensionTypeEnum.MCP
      )

      // Fetch tools and tool names in parallel
      const [mcpTools, ragToolNames] = await Promise.all([
        getServiceHub().mcp().getTools(),
        getServiceHub().rag().getToolNames?.() ?? Promise.resolve([]),
      ])

      if (mine !== latest) return

      // Update MCP tools
      h.updateTools(mcpTools)

      const mcpNames = mcpTools.map((t) => t.name)
      const mcpNameSet = new Set(mcpNames)
      const ragOnly = ragToolNames.filter((n) => !mcpNameSet.has(n))
      if (ragOnly.length !== ragToolNames.length) {
        const shadowed = ragToolNames.filter((n) => mcpNameSet.has(n))
        console.warn(
          `[tools] RAG tool(s) shadowed by MCP and routed to MCP: ${shadowed.join(', ')}`
        )
      }
      h.updateMcpToolNames(mcpNames)
      h.updateRagToolNames(ragOnly)

      // Initialize default disabled tools for new users (only once)
      if (!h.isDefaultsInitialized() && mcpTools.length > 0 && mcpExtension?.getDefaultDisabledTools) {
        const defaultDisabled = await mcpExtension.getDefaultDisabledTools()
        if (defaultDisabled.length > 0) {
          h.setDisabledTools(defaultDisabled)
        }
        h.markDefaultsAsInitialized()
      }
    } catch (error) {
      console.error('Failed to fetch MCP tools:', error)
    }
  }
  setTools()

  let unsubscribe: (() => void) | undefined
  let cancelled = false
  getServiceHub().events().listen(SystemEvent.MCP_UPDATE, setTools).then((unsub) => {
    // listen() can resolve after unmount; drop the subscription then.
    if (cancelled) unsub()
    else unsubscribe = unsub
  }).catch((error) => {
    console.error('Failed to set up MCP update listener:', error)
  })
  return () => {
    cancelled = true
    unsubscribe?.()
  }
}

export const useTools = () => {
  const updateTools = useAppState((state) => state.updateTools)
  const updateRagToolNames = useAppState((state) => state.updateRagToolNames)
  const updateMcpToolNames = useAppState((state) => state.updateMcpToolNames)
  const isDefaultsInitialized = useToolAvailable((s) => s.isDefaultsInitialized)
  const setDisabledTools = useToolAvailable((s) => s.setDisabledTools)
  const markDefaultsAsInitialized = useToolAvailable((s) => s.markDefaultsAsInitialized)

  current = {
    updateTools,
    updateRagToolNames,
    updateMcpToolNames,
    isDefaultsInitialized,
    setDisabledTools,
    markDefaultsAsInitialized,
  }

  useEffect(() => {
    mounts++
    if (mounts === 1) stopShared = startShared()
    return () => {
      mounts--
      if (mounts === 0) {
        stopShared?.()
        stopShared = undefined
      }
    }
  }, [])
}
