import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  listed: [] as {
    name: string
    server: string
    description: string
    inputSchema: Record<string, unknown>
  }[],
  getTools: vi.fn(),
  getRelevantTools: vi.fn(),
  summaries: [] as { name: string }[],
  disabled: [] as string[],
}))

vi.mock('@/hooks/useServiceHub', () => {
  const hub = {
    mcp: () => ({
      getTools: h.getTools,
      getServerSummaries: async () => h.summaries,
      getToolsForServers: async () => [],
    }),
    rag: () => ({ getTools: async () => [] }),
  }
  return {
    getServiceHub: () => hub,
    useServiceStore: { getState: () => ({ serviceHub: hub }) },
  }
})
vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: {
    getState: () => ({
      getDisabledTools: () => h.disabled,
      isToolDisabled: (s: string, t: string) => h.disabled.includes(`${s}::${t}`),
    }),
  },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      selectedModel: { capabilities: ['tools'] },
      selectedProvider: '',
      getProviderByName: () => null,
    }),
  },
}))
vi.mock('@/lib/agentTools', () => ({
  sandboxEnforces: () => true,
  getAgentToolSchemas: async () => [],
}))
vi.mock('@/lib/coworkTools', async (orig) => ({
  ...(await orig<typeof import('../coworkTools')>()),
  buildCoworkTools: async () => ({ read: {} }),
}))
vi.mock('../model-factory', () => ({ ModelFactory: { createModel: vi.fn() } }))
vi.mock('@/lib/mcp-orchestrator', () => ({
  mcpOrchestrator: {
    getRelevantTools: (...a: unknown[]) => h.getRelevantTools(...a),
    invalidateCache: vi.fn(),
  },
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }))

import { toast } from 'sonner'
import { CustomChatTransport } from '../custom-chat-transport'
import { CoworkChatTransport } from '../coworkTransport'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useAppState } from '@/hooks/useAppState'
import { bumpMcpGeneration, clearMcpBaselines } from '../mcpLiveTools'

const ida = {
  name: 'ida_decompile',
  server: 'ida-multi-mcp',
  description: 'decompile',
  inputSchema: { type: 'object', properties: {} },
}
const other = { ...ida, name: 'other_tool', server: 'other' }

const turnOn = (name: string) =>
  useMCPServers.setState({
    mcpServers: {
      ...useMCPServers.getState().mcpServers,
      [name]: { command: 'x', args: [], env: {}, active: true },
    },
  } as never)

const promptOf = (t: unknown) =>
  (t as { buildSystemPrompt: (m: unknown[]) => string }).buildSystemPrompt([])

beforeEach(() => {
  h.disabled = []
  h.summaries = []
  h.getTools.mockReset()
  h.getRelevantTools.mockReset()
  useMCPServers.setState({
    mcpServers: {},
    settings: { enableSmartToolRouting: false },
  } as never)
  useAppState.setState({ tools: [], mcpToolNames: new Set() } as never)
  bumpMcpGeneration()
  clearMcpBaselines()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('a server that fails to start', () => {
  it('chat keeps working without its tools and retries on the next send', async () => {
    turnOn('ida-multi-mcp')
    h.getTools.mockRejectedValueOnce(new Error('spawn failed'))
    const t = new CustomChatTransport('sys', 'thread-f')
    await expect(t.refreshTools(undefined, true)).resolves.toBeUndefined()
    expect(Object.keys(t.getTools())).not.toContain('ida_decompile')
    expect(promptOf(t)).not.toContain('MCP servers changed')

    // Nothing moved the generation: the failure itself must not be kept.
    h.getTools.mockResolvedValue([ida])
    await t.refreshTools(undefined, true)
    expect(Object.keys(t.getTools())).toContain('ida_decompile')
  })

  it('Cowork keeps its built-in tools and retries on the next request', async () => {
    turnOn('ida-multi-mcp')
    h.getTools.mockRejectedValueOnce(new Error('spawn failed'))
    const t = new CoworkChatTransport('s1', coworkConfig())
    await expect(t.refreshTools()).resolves.toBeUndefined()
    expect(Object.keys(t.advertisedTools)).toEqual(['read'])
    expect(t.mcpServerFor('ida_decompile')).toBeUndefined()

    h.getTools.mockResolvedValue([ida])
    await t.refreshTools()
    expect(Object.keys(t.advertisedTools)).toContain('ida_decompile')
  })
})

describe('smart tool routing', () => {
  beforeEach(() => {
    useMCPServers.setState({
      mcpServers: {},
      settings: {
        enableSmartToolRouting: true,
        useLightweightRouterModel: false,
        routerModelProvider: '',
        routerModelId: '',
      },
    } as never)
    h.summaries = [{ name: 'ida-multi-mcp' }, { name: 'other' }]
    turnOn('ida-multi-mcp')
    turnOn('other')
  })

  it('advertises only the routed subset and leaves the full-listing store alone', async () => {
    h.getRelevantTools.mockResolvedValue([ida])
    const t = new CustomChatTransport('sys', 'thread-r')
    await t.refreshTools(undefined, true)
    const names = Object.keys(t.getTools())
    expect(names).toContain('ida_decompile')
    expect(names).not.toContain('other_tool')
    expect(h.getTools).not.toHaveBeenCalled()
    expect(useAppState.getState().mcpToolNames.size).toBe(0)
  })

  it('names no change while the routed set stays the same', async () => {
    h.getRelevantTools.mockResolvedValue([ida])
    const t = new CustomChatTransport('sys', 'thread-r')
    await t.refreshTools(undefined, true)
    bumpMcpGeneration()
    await t.refreshTools(undefined, true)
    expect(promptOf(t)).not.toContain('MCP servers changed')
  })

  it('keeps the first routed subset for the thread while the servers are the same', async () => {
    h.getRelevantTools.mockResolvedValue([ida])
    const t = new CustomChatTransport('sys', 'thread-r')
    await t.refreshTools(undefined, true)
    h.getRelevantTools.mockResolvedValue([other])
    bumpMcpGeneration()
    await t.refreshTools(undefined, true)
    expect(h.getRelevantTools).toHaveBeenCalledTimes(1)
    expect(Object.keys(t.getTools())).toContain('ida_decompile')
  })

  it('routes again when a server appears, and says so', async () => {
    h.getRelevantTools.mockResolvedValue([ida])
    const t = new CustomChatTransport('sys', 'thread-r')
    await t.refreshTools(undefined, true)
    h.summaries = [...h.summaries, { name: 'third' }]
    h.getRelevantTools.mockResolvedValue([ida, { ...other, server: 'third', name: 'third_tool' }])
    bumpMcpGeneration()
    await t.refreshTools(undefined, true)
    expect(h.getRelevantTools).toHaveBeenCalledTimes(2)
    expect(promptOf(t)).toContain('third is now available')
  })
})

const coworkConfig = (over = {}) => ({
  planMode: false,
  webSearch: false,
  subagentNames: [],
  allowSubagents: false,
  workspacePath: '/ws/s1',
  readOnlyFolder: null,
  ...over,
})

