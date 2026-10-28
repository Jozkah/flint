import { refreshPluginInventory } from '@/lib/pluginInventory'
import { refreshSkillCatalog } from '@/lib/skillCatalog'
import { type LanguageModel, type Tool, jsonSchema } from 'ai'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { deadTools } from '@/lib/deadTools'
import { ModelFactory } from '@/lib/model-factory'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { useAttachments } from '@/hooks/useAttachments'
import { useMCPServers } from '@/hooks/useMCPServers'
import { webSearchOnFor } from '@/hooks/useWebSearchChoice'
import { recordRunWebTools, WEB_SEARCH_DESCRIPTION, WEB_SEARCH_INPUT_SCHEMA, WEB_FETCH_DESCRIPTION, WEB_FETCH_INPUT_SCHEMA, IMAGE_SEARCH_DESCRIPTION, IMAGE_SEARCH_INPUT_SCHEMA } from '@/lib/webSearchTool'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { getAgentToolSchemas, SHELL_TOOL_NAME } from '@/lib/agentTools'
import { chatDelegationEnabled, chatDelegationTools } from '@/lib/chatDelegation'
import { useVisualizeConfig } from '@/hooks/useVisualizeConfig'
import { isImageTool } from '@/lib/chatImageTools'
import { studioApi } from '@/lib/studio/studio'
import { visualizeSchemas } from '@/lib/visualize/tools'
import { chatReadSchema } from '@/lib/chatReadTool'
import { chatReadWanted } from '@/lib/chatMentionSources'
import { SESSION_MESSAGING_TOOLS } from '@/lib/sessionMessagingTools'
import { useAppState } from '@/hooks/useAppState'
import { ExtensionManager } from '@/lib/extension'
import { threadToolsGranted } from '@/hooks/useThreadToolGrants'
import { ExtensionTypeEnum, VectorDBExtension, type MCPTool } from '@janhq/core'
import { mcpOrchestrator } from '@/lib/mcp-orchestrator'
import { isRouterModelSelectable } from '@/lib/mcp-router-model-filter'
import { announceMcpChange, announceMcpWithheld, mcpAvailability, diffMcpSnapshots, enabledMcpServers, getMcpGeneration, loadLiveMcpTools, mcpChangeNote, mcpStartingNote, readMcpBaseline, snapshotMcpTools, syncMcpStore, writeMcpBaseline } from '@/lib/mcpLiveTools'
import { isSelfApprovalTool } from '@/lib/selfApprovalTools'
import { filterToolsByServers, threadMcpAllowList } from '@/lib/projectMcpServers'
import { isValidToolName, normalizeToolInputSchema } from '@/lib/chat/transport/toolSchema'
import type { ServiceHub } from '@/lib/custom-chat-transport'

// Tool listing for the chat transport, moved out of `CustomChatTransport`
// unchanged. The class state it reads and writes goes through
// `ToolRefreshHost`; the class methods delegate here.

export interface ToolRefreshHost {
  serviceHub: ServiceHub | null
  threadId: string | undefined
  lastUserMessage: string
  hasDocuments: boolean
  ragFeatureAvailable: boolean
  modelSupportsTools: boolean
  model: LanguageModel | null
  routerModel: LanguageModel | null
  routerModelKey: string
  tools: Record<string, Tool>
  loadedTools: Record<string, Tool> | null
  toolsCacheKey: string | null
  toolServers: Map<string, string>
  delegationNames: string[]
  frozenRoutedTools: MCPTool[] | null
  frozenRoutedSig: string
  mcpStartingText: string | null
  mcpChangeText: string | null
  getModelSelection(): {
    selectedModel?: { id?: string; capabilities?: string[] } | null
  }
  chatShellWithheld(): boolean
  /** Overridable by subclasses: Cowork records its own set. */
  recordMcpSet(
    advertised: { name: string; server?: string }[],
    listed?: MCPTool[]
  ): void
}

export const BUILTIN_WEB_TOOLS = new Set(['web_search', 'web_fetch', 'image_search'])

export async function refreshTools(
  host: ToolRefreshHost,
  abortSignal?: AbortSignal,
  useCache = false
): Promise<void> {
  if (!host.serviceHub) {
    host.tools = {}
    host.toolsCacheKey = null
    return
  }

  const toolsRecord: Record<string, Tool> = {}
  const toolServers = new Map<string, string>()
  // A failed MCP listing is not kept: the next send asks again.
  let mcpLoadFailed = false

  // Tool availability is global (shared across all chats).
  const disabledToolKeys = useToolAvailable.getState().getDisabledTools()
  const isToolDisabled = (serverName: string, toolName: string): boolean => {
    const toolKey = `${serverName}::${toolName}`
    return disabledToolKeys.includes(toolKey)
  }

  const selectedModel = host.getModelSelection().selectedModel
  const modelSupportsTools =
    (selectedModel?.capabilities?.includes('tools') ?? host.modelSupportsTools) ||
    threadToolsGranted(host.threadId)
  // Whether there are documents is read live, before the cache check: a
  // file attached to the thread's project mid-thread changes nothing else
  // in the key, and `host.hasDocuments` is only refreshed by the thread
  // view, so a key built from it kept the RAG tools away (#128).
  let hasDocuments = host.hasDocuments
  let ragFeatureAvailable = host.ragFeatureAvailable
  if (modelSupportsTools) {
    if (!hasDocuments && host.threadId) {
      const thread = useThreads.getState().threads[host.threadId]
      const hasThreadDocuments = Boolean(thread?.metadata?.hasDocuments)

      const projectId = thread?.metadata?.project?.id
      if (projectId) {
        try {
          const ext = ExtensionManager.getInstance().get<VectorDBExtension>(
            ExtensionTypeEnum.VectorDB
          )
          if (ext?.listAttachmentsForProject) {
            const projectFiles = await ext.listAttachmentsForProject(projectId)
            hasDocuments = hasThreadDocuments || projectFiles.length > 0
          }
        } catch (error) {
          console.warn('Failed to check project files:', error)
          hasDocuments = hasThreadDocuments
        }
      } else {
        hasDocuments = hasThreadDocuments
      }
    }

    if (!ragFeatureAvailable) {
      ragFeatureAvailable = Boolean(useAttachments.getState().enabled)
    }
  }
  // The MCP tools that exist right now. Without it a server installed or
  // activated after the chat opened never reached the chat: every send
  // found the old key and kept the old tool list, so it took a new chat.
  const mcpNames: unknown = useAppState.getState?.()?.mcpToolNames
  const mcpFingerprint =
    mcpNames instanceof Set || Array.isArray(mcpNames)
      ? [...(mcpNames as Iterable<string>)].sort()
      : []
  // A project may limit its chats to some MCP servers (null = all).
  const mcpAllow = threadMcpAllowList(host.threadId)
  const cacheKey = JSON.stringify({
    mcpFingerprint,
    mcpAllow: mcpAllow ? [...mcpAllow].sort() : null,
    routedQuery: useMCPServers.getState().settings.enableSmartToolRouting
      ? host.lastUserMessage
      : undefined,
    // A server switched on after the chat began has no tools until it is
    // started, so the fingerprint alone cannot see it.
    mcpGeneration: getMcpGeneration(),
    mcpEnabled: enabledMcpServers(),
    model: selectedModel?.id ?? '',
    modelSupportsTools,
    hasDocuments,
    ragFeatureAvailable,
    disabledToolKeys,
    deadTools: deadTools(host.threadId),
    webSearchEnabled: webSearchOnFor(host.threadId),
    agentToolsEnabled: useAgentToolsConfig.getState().agentToolsEnabled,
    chatShellWithheld: host.chatShellWithheld(),
    chatDelegation: chatDelegationEnabled(),
    visualizeEnabled: useVisualizeConfig.getState().enabled,
  })
  if (useCache && host.toolsCacheKey === cacheKey) {
    if (host.loadedTools) host.tools = host.loadedTools
    recordRunWebTools(host.threadId, host.tools)
    return
  }

  // Only load tools if model supports them
  if (modelSupportsTools) {
    // Load RAG tools if documents are available
    if (hasDocuments && ragFeatureAvailable) {
      try {
        const ragTools = await host.serviceHub.rag().getTools()
        if (Array.isArray(ragTools) && ragTools.length > 0) {
          // Convert RAG tools to AI SDK format, filtering out disabled tools
          ragTools.forEach((tool) => {
            if (!isValidToolName(tool.name)) return
            // RAG tools use MCPTool interface with server field
            const serverName =
              (tool as { server?: string }).server || 'unknown'
            if (!isToolDisabled(serverName, tool.name)) {
              toolsRecord[tool.name] = {
                description: tool.description,
                inputSchema: jsonSchema(
                  normalizeToolInputSchema(tool.inputSchema as Record<string, unknown>)
                ),
              } as Tool
            }
          })
        }
      } catch (error) {
        console.warn('Failed to load RAG tools:', error)
      }
    }

    // Load MCP tools — route through the orchestrator when available so only
    // relevant servers are queried instead of all of them.
    try {
      const mcpService = host.serviceHub.mcp()
      let mcpTools: MCPTool[]
      let mcpStarting: string[] = []
      // Smart routing lists a subset; only a full listing may refresh the
      // store the tool picker and the call dispatcher read.
      let fullListing = false
      const mcpSettings = useMCPServers.getState().settings
      const routingEnabled = mcpSettings.enableSmartToolRouting

      if (
        routingEnabled &&
        mcpService.getToolsForServers &&
        mcpService.getServerSummaries
      ) {
        const summaries = await mcpService.getServerSummaries!()
        const routedSig = JSON.stringify({
          // Tool identities, not only server names: a server that gains
          // tools must re-route rather than keep the frozen subset.
          tools: mcpFingerprint,
          servers: summaries.map((s) => s.name).sort(),
          disabled: [...disabledToolKeys].sort(),
          query: host.lastUserMessage,
        })
        if (host.frozenRoutedTools && host.frozenRoutedSig === routedSig) {
          mcpTools = host.frozenRoutedTools
        } else {
          const routerModel =
            mcpSettings.useLightweightRouterModel &&
            mcpSettings.routerModelProvider.trim() &&
            mcpSettings.routerModelId.trim()
              ? (await resolveRouterModel(host, mcpSettings)) ?? host.model
              : host.model
          mcpTools = await mcpOrchestrator.getRelevantTools(
            host.lastUserMessage,
            {
              // The router decides from server summaries, then only the
              // servers it selects are started (on demand).
              getTools: () => mcpService.getTools({ start: true }),
              getToolsForServers: (names) =>
                mcpService.getToolsForServers!(names, { start: true }),
              getServerSummaries: () => Promise.resolve(summaries),
            },
            disabledToolKeys,
            {
              routerModel,
              abortSignal,
            }
          )
          host.frozenRoutedTools = mcpTools
          host.frozenRoutedSig = routedSig
        }
      } else {
        // A send that uses tools starts enabled servers on demand, waiting
        // a bounded time for ones still starting.
        const live = await loadLiveMcpTools(mcpService)
        mcpTools = live.tools
        mcpStarting = live.starting
        fullListing = true
      }
      if (mcpAllow) {
        mcpTools = filterToolsByServers(mcpTools ?? [], mcpAllow)
        mcpStarting = mcpStarting.filter((s) => mcpAllow.has(s))
      }
      host.mcpStartingText = mcpStartingNote(mcpStarting)

      if (Array.isArray(mcpTools) && mcpTools.length > 0) {
        const seenBy = new Map<string, string>()
        mcpTools.forEach((tool) => {
          if (!isValidToolName(tool.name)) return
          const serverName = tool.server || 'unknown'
          if (isToolDisabled(serverName, tool.name)) return
          // A tool that approves the server's own held commands is never
          // offered: Flint's prompt is the only approval, and the model
          // looped on approve/execute pairs when it had one.
          if (isSelfApprovalTool(tool.name)) return
          // A server must not shadow a built-in: its tool would be routed to
          // the server instead of the app's own implementation.
          if (BUILTIN_WEB_TOOLS.has(tool.name)) {
            console.warn(
              `[tools] MCP tool "${tool.name}" from "${serverName}" ignored: the name belongs to a built-in web tool.`
            )
            return
          }
          const prevServer = seenBy.get(tool.name)
          if (prevServer && prevServer !== serverName) {
            console.warn(
              `[tools] MCP tool name collision: "${tool.name}" exposed by both "${prevServer}" and "${serverName}". Using "${serverName}".`
            )
          }
          seenBy.set(tool.name, serverName)
          toolServers.set(tool.name, serverName)
          toolsRecord[tool.name] = {
            description: tool.description,
            inputSchema: jsonSchema(
              normalizeToolInputSchema(tool.inputSchema as Record<string, unknown>)
            ),
          } as Tool
        })
      }
      if (fullListing) {
        // Enabled servers that offered nothing are said so, to the model and
        // to the person, instead of being left out without a word.
        const availability = mcpAvailability(
          mcpTools,
          snapshotMcpTools(
            [...toolServers].map(([name, server]) => ({ name, server }))
          ),
          mcpStarting,
          isToolDisabled,
          mcpAllow
            ? enabledMcpServers().filter((s) => mcpAllow.has(s))
            : enabledMcpServers()
        )
        host.mcpStartingText =
          [host.mcpStartingText, availability.note]
            .filter((s): s is string => Boolean(s))
            .join(' ') || null
        announceMcpWithheld(availability.withheld)
      }
      recordMcpSet(host, 
        [...toolServers].map(([name, server]) => ({ name, server })),
        fullListing ? mcpTools : undefined
      )
    } catch (error) {
      console.warn('Failed to load MCP tools:', error)
      mcpLoadFailed = true
    }

    // Native web tools, provided by the websearch plugin (not an MCP server).
    // Advertised whenever the user has web search enabled.
    if (webSearchOnFor(host.threadId)) {
      toolsRecord['web_search'] = {
        description: WEB_SEARCH_DESCRIPTION,
        inputSchema: jsonSchema(WEB_SEARCH_INPUT_SCHEMA as Record<string, unknown>),
      } as Tool
      toolsRecord['web_fetch'] = {
        description: WEB_FETCH_DESCRIPTION,
        inputSchema: jsonSchema(WEB_FETCH_INPUT_SCHEMA as Record<string, unknown>),
      } as Tool
      toolsRecord['image_search'] = {
        description: IMAGE_SEARCH_DESCRIPTION,
        inputSchema: jsonSchema(IMAGE_SEARCH_INPUT_SCHEMA as Record<string, unknown>),
      } as Tool
    }

    // Inline widgets are the renderer's own and need no workspace, so they
    // are offered whether or not the agent tools are on.
    if (useVisualizeConfig.getState().enabled) {
      for (const schema of visualizeSchemas()) {
        toolsRecord[schema.function.name] = {
          description: schema.function.description,
          inputSchema: jsonSchema(schema.function.parameters),
        } as Tool
      }
    }

    // Read more of a conversation the user mentioned (docs/CHAT_MENTIONS.md).
    // Offered only once this chat has a mention (or the user allows reading
    // any conversation), so an ordinary chat's tool list is unchanged.
    if (host.threadId && chatReadWanted(host.threadId)) {
      const schema = chatReadSchema()
      toolsRecord[schema.function.name] = {
        description: schema.function.description,
        inputSchema: jsonSchema(schema.function.parameters),
      } as Tool
    }

    // Picture tools, offered only while Studio has an image model loaded: they
    // never load one, so without it every call would just fail.
    try {
      const studio = await studioApi.status()
      if (studio.supported && studio.resident?.kind === 'image') {
        for (const schema of await getAgentToolSchemas()) {
          if (!isImageTool(schema.function?.name)) continue
          toolsRecord[schema.function.name] = {
            description: schema.function.description,
            inputSchema: jsonSchema(schema.function.parameters),
          } as Tool
        }
      }
    } catch {
      // Studio is not available here (no desktop engine): no picture tools.
    }

    // Built-in agent tools (filesystem reads plus skills/memory), provided by
    // the agent-tools plugin. Schemas come from Rust so they are never
    // re-typed here.
    // Plugin state is Flint's own, not a workspace tool, so it is read and
    // `list_plugins` offered whether or not the agent tools are on: without
    // it a model asked "is <plugin> enabled?" goes digging through shells.
    // Read before the system prompt is assembled, which names the enabled
    // plugins from this cache.
    await refreshPluginInventory()
    await refreshSkillCatalog()
    if (!useAgentToolsConfig.getState().agentToolsEnabled) {
      try {
        const listPlugins = (await getAgentToolSchemas()).find(
          (s) => s.function?.name === 'list_plugins'
        )
        if (listPlugins) {
          toolsRecord.list_plugins = {
            description: listPlugins.function.description,
            inputSchema: jsonSchema(listPlugins.function.parameters),
          } as Tool
        }
      } catch (error) {
        console.warn('Failed to load list_plugins:', error)
      }
    }
    if (useAgentToolsConfig.getState().agentToolsEnabled) {
      try {
        for (const schema of await getAgentToolSchemas()) {
          if (!isValidToolName(schema.function?.name)) continue
          // Session-scope tools: a chat thread has no mailbox identity.
          if (SESSION_MESSAGING_TOOLS.has(schema.function.name)) continue
          toolsRecord[schema.function.name] = {
            description: schema.function.description,
            inputSchema: jsonSchema(schema.function.parameters),
          } as Tool
        }
      } catch (error) {
        console.warn('Failed to load agent tools:', error)
      }
      // A job handed to a subagent: the Cowork `task` family on the chat's
      // own footing, behind its own setting.
      try {
        const offered = await chatDelegationTools()
        Object.assign(toolsRecord, offered.tools)
        host.delegationNames = offered.names
      } catch (error) {
        console.warn('Failed to load delegation tools:', error)
      }
    }
  }

  // A tool its server does not implement is no longer offered in this
  // conversation (transcript audit #11).
  for (const name of deadTools(host.threadId)) delete toolsRecord[name]
  // Chat's own shell switch (Cowork does not read it).
  if (host.chatShellWithheld()) delete toolsRecord[SHELL_TOOL_NAME]
  // Sorted by name: the tool list is part of the prompt, and a server that
  // reconnects in a different order would otherwise change the prefix and
  // throw away the model's prompt cache.
  host.tools = Object.fromEntries(
    Object.entries(toolsRecord).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
  )
  host.toolServers = toolServers
  host.loadedTools = host.tools
  recordRunWebTools(host.threadId, host.tools)
  host.toolsCacheKey = mcpLoadFailed ? null : cacheKey
}

export function recordMcpSet(
  host: ToolRefreshHost,
  advertised: { name: string; server?: string }[],
  listed?: MCPTool[]
): void {
  const next = snapshotMcpTools(advertised)
  const key = host.threadId ?? ''
  const before = readMcpBaseline(key)
  let note = before?.note ?? null
  if (listed) syncMcpStore(listed)
  if (before) {
    const change = diffMcpSnapshots(before.snapshot, next)
    const changed = mcpChangeNote(change)
    if (changed) {
      note = changed
      announceMcpChange(change)
    }
  }
  writeMcpBaseline(key, next, note)
  host.mcpChangeText = note
}

async function resolveRouterModel(
  host: ToolRefreshHost,
  settings: {
    useLightweightRouterModel: boolean
    routerModelProvider: string
    routerModelId: string
  }
): Promise<LanguageModel | null> {
  if (!settings.useLightweightRouterModel) return null
  const providerName = settings.routerModelProvider.trim()
  const modelId = settings.routerModelId.trim()
  if (!providerName || !modelId) return null

  const key = `${providerName}::${modelId}`
  if (host.routerModel && host.routerModelKey === key) {
    return host.routerModel
  }

  const provider = useModelProvider.getState().getProviderByName(providerName)
  if (!provider) {
    console.warn(
      `[MCP] Router model provider '${providerName}' not found; using chat model for routing.`
    )
    return null
  }

  const catalogModel = provider.models.find((m) => m.id === modelId)
  if (!catalogModel || !isRouterModelSelectable(provider, catalogModel)) {
    console.warn(
      `[MCP] Router model '${key}' is not allowed for routing (use a lightweight model with API access); using chat model for routing.`
    )
    return null
  }

  try {
    const model = await ModelFactory.createModel(modelId, provider, {})
    host.routerModel = model
    host.routerModelKey = key
    return model
  } catch (error) {
    console.warn(
      `[MCP] Failed to create router model '${key}'; using chat model for routing.`,
      error
    )
    host.routerModel = null
    host.routerModelKey = ''
    return null
  }
}
