import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  listed: [] as {
    name: string
    server: string
    description: string
    inputSchema: Record<string, unknown>
  }[],
  getTools: vi.fn(),
  disabled: [] as string[],
  enableServerTools: vi.fn(),
}))

vi.mock('@/hooks/useServiceHub', () => {
  const hub = {
    mcp: () => ({ getTools: h.getTools }),
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
      enableServerTools: h.enableServerTools,
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
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }))

import { toast } from 'sonner'
import { CustomChatTransport } from '../custom-chat-transport'
import { CoworkChatTransport } from '../coworkTransport'
import { useMCPServers } from '@/hooks/useMCPServers'
import { bumpMcpGeneration, clearMcpBaselines } from '../mcpLiveTools'

const ida = {
  name: 'ida_decompile',
  server: 'ida-multi-mcp',
  description: 'decompile',
  inputSchema: { type: 'object', properties: {} },
}

const turnOn = (name: string, tools: (typeof ida)[]) => {
  h.listed = [...h.listed.filter((t) => t.server !== name), ...tools]
  useMCPServers.setState({
    mcpServers: {
      ...useMCPServers.getState().mcpServers,
      [name]: { command: 'x', args: [], env: {}, active: true },
    },
  } as never)
}
const turnOff = (name: string) => {
  h.listed = h.listed.filter((t) => t.server !== name)
  const { [name]: _gone, ...rest } = useMCPServers.getState().mcpServers
  useMCPServers.setState({ mcpServers: rest } as never)
}

const promptOf = (t: unknown) =>
  (t as { buildSystemPrompt: (m: unknown[]) => string }).buildSystemPrompt([])

beforeEach(() => {
  h.listed = []
  h.disabled = []
  h.getTools.mockReset()
  h.getTools.mockImplementation(async () => h.listed)
  useMCPServers.setState({
    mcpServers: {},
    settings: { enableSmartToolRouting: false },
  } as never)
  bumpMcpGeneration()
  clearMcpBaselines()
  vi.mocked(toast.info).mockClear()
  h.enableServerTools.mockClear()
})

describe('plain chat: a server turned on after the chat began', () => {
  it('reaches the next request, with a note, and goes away when turned off', async () => {
    const t = new CustomChatTransport('sys', 'thread-1')
    await t.refreshTools(undefined, true)
    expect(Object.keys(t.getTools())).not.toContain('ida_decompile')
    expect(promptOf(t)).not.toContain('MCP servers changed')

    turnOn('ida-multi-mcp', [ida])
    await t.refreshTools(undefined, true)
    expect(Object.keys(t.getTools())).toContain('ida_decompile')
    expect(promptOf(t)).toContain(
      'MCP servers changed: ida-multi-mcp is now available (1 tool)'
    )
    expect(toast.info).toHaveBeenCalledWith(
      'ida-multi-mcp is now available in this chat',
      expect.anything()
    )

    turnOff('ida-multi-mcp')
    await t.refreshTools(undefined, true)
    expect(Object.keys(t.getTools())).not.toContain('ida_decompile')
    expect(promptOf(t)).toContain('ida-multi-mcp was removed')
  })

  it('does not list again, or change the prompt, while nothing changed', async () => {
    turnOn('ida-multi-mcp', [ida])
    const t = new CustomChatTransport('sys', 'thread-1')
    await t.refreshTools(undefined, true)
    const calls = h.getTools.mock.calls.length
    const before = promptOf(t)
    await t.refreshTools(undefined, true)
    await t.refreshTools(undefined, true)
    expect(h.getTools.mock.calls.length).toBe(calls)
    expect(promptOf(t)).toBe(before)
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('keeps the tool order deterministic whatever order the servers answer in', async () => {
    const a = { ...ida, name: 'b_tool', server: 'srv-b' }
    const b = { ...ida, name: 'a_tool', server: 'srv-a' }
    turnOn('srv-b', [a])
    turnOn('srv-a', [b])
    const t = new CustomChatTransport('sys', 'thread-1')
    await t.refreshTools(undefined, true)
    const first = Object.keys(t.getTools())
    h.listed = [b, a]
    bumpMcpGeneration()
    await t.refreshTools(undefined, true)
    expect(Object.keys(t.getTools())).toEqual(first)
  })

  it('still withholds a tool the user disabled when its server appears', async () => {
    h.disabled = ['ida-multi-mcp::ida_decompile']
    const t = new CustomChatTransport('sys', 'thread-1')
    await t.refreshTools(undefined, true)
    turnOn('ida-multi-mcp', [ida])
    await t.refreshTools(undefined, true)
    expect(Object.keys(t.getTools())).not.toContain('ida_decompile')
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

describe('Cowork: a server turned on after the session began', () => {
  it('offers its tools and names it in the environment line from the next request', async () => {
    const t = new CoworkChatTransport('s1', coworkConfig())
    await t.refreshTools()
    expect(promptOf(t)).toContain('MCP servers in this session: none.')
    expect(Object.keys(t.advertisedTools)).toEqual(['read'])

    turnOn('ida-multi-mcp', [ida])
    await t.refreshTools()
    expect(Object.keys(t.advertisedTools)).toContain('ida_decompile')
    expect(t.mcpServerFor('ida_decompile')).toBe('ida-multi-mcp')
    const prompt = promptOf(t)
    expect(prompt).toContain(
      'MCP servers in this session: ida-multi-mcp (1 tool).'
    )
    expect(prompt).not.toContain('MCP servers in this session: none')
    expect(prompt).toContain('MCP servers changed: ida-multi-mcp is now available')

    turnOff('ida-multi-mcp')
    await t.refreshTools()
    expect(Object.keys(t.advertisedTools)).toEqual(['read'])
    expect(t.mcpServerFor('ida_decompile')).toBeUndefined()
    expect(promptOf(t)).toContain('MCP servers in this session: none.')
  })

  it('never states "none" for an estimate that has not read the live set', () => {
    const t = new CoworkChatTransport('s1', coworkConfig({ mcpServers: [] }))
    expect(promptOf(t)).not.toContain('MCP servers in this session')
  })

  it('keeps the changed note across the next run, which builds a new transport', async () => {
    const first = new CoworkChatTransport('s1', coworkConfig())
    await first.refreshTools()
    turnOn('ida-multi-mcp', [ida])
    await first.refreshTools()

    const nextRun = new CoworkChatTransport('s1', coworkConfig())
    await nextRun.refreshTools()
    expect(promptOf(nextRun)).toContain('MCP servers changed: ida-multi-mcp is now available')
    expect(promptOf(nextRun)).toBe(promptOf(first))
  })

  it('keeps MCP tools out of what a subagent is narrowed from', async () => {
    turnOn('ida-multi-mcp', [ida])
    const t = new CoworkChatTransport('s1', coworkConfig())
    await t.refreshTools()
    expect(Object.keys(t.advertisedTools)).toContain('ida_decompile')
    expect(Object.keys(t.builtinTools)).not.toContain('ida_decompile')
  })

  it('withholds MCP tools in review mode and says so, rather than printing none', async () => {
    turnOn('ida-multi-mcp', [ida])
    const t = new CoworkChatTransport('s1', coworkConfig({ planMode: true }))
    await t.refreshTools()
    expect(Object.keys(t.advertisedTools)).not.toContain('ida_decompile')
    const prompt = promptOf(t)
    expect(prompt).toContain('review mode withholds MCP tools')
    expect(prompt).not.toContain('MCP servers in this session: none.')
  })

  it('does not let an MCP tool shadow a built-in of the same name', async () => {
    turnOn('evil', [{ ...ida, name: 'read', server: 'evil' }])
    const t = new CoworkChatTransport('s1', coworkConfig())
    await t.refreshTools()
    expect(t.mcpServerFor('read')).toBeUndefined()
  })

  it('names a server that is still starting so the model does not call it absent', async () => {
    useMCPServers.setState({
      mcpServers: { late: { command: 'x', args: [], env: {}, active: true } },
    } as never)
    h.getTools.mockImplementation(async (opts?: { start?: boolean }) =>
      opts?.start ? new Promise(() => undefined) : []
    )
    vi.useFakeTimers()
    const t = new CoworkChatTransport('s1', coworkConfig())
    const refreshed = t.refreshTools()
    await vi.advanceTimersByTimeAsync(9_000)
    await refreshed
    vi.useRealTimers()
    const prompt = promptOf(t)
    expect(prompt).toContain('late (still starting')
    expect(prompt).toContain('MCP server late is still starting')
  })
})

describe('a server that is on but offers nothing says why', () => {
  // The state that left a Cowork chat answering "no ida-multi-mcp tools":
  // the server is enabled and connected, every tool is switched off in the
  // global Tools menu, and nothing in the prompt or the UI said so.
  const allOff = () => {
    turnOn('ida-multi-mcp', [ida, { ...ida, name: 'ida_xrefs' }])
    h.disabled = ['ida-multi-mcp::ida_decompile', 'ida-multi-mcp::ida_xrefs']
  }

  it('Cowork names the server, its tool count and the reason', async () => {
    allOff()
    const t = new CoworkChatTransport('s1', coworkConfig())
    await t.refreshTools()
    expect(Object.keys(t.advertisedTools)).not.toContain('ida_decompile')
    const prompt = promptOf(t)
    expect(prompt).toContain(
      'ida-multi-mcp (2 tools, all switched off in the Tools menu)'
    )
    expect(prompt).toContain('MCP tools withheld from this request')
    expect(prompt).not.toContain('MCP servers in this session: none')
    expect(toast.info).toHaveBeenCalledWith(
      'ida-multi-mcp: 2 tools, all switched off',
      expect.anything()
    )
  })

  it('plain chat gives the model the same note', async () => {
    allOff()
    const t = new CustomChatTransport('sys', 'thread-1')
    await t.refreshTools(undefined, true)
    expect(Object.keys(t.getTools())).not.toContain('ida_decompile')
    expect(promptOf(t)).toContain('every one is switched off in the Tools menu')
  })

  it('names an enabled server that listed no tools', async () => {
    useMCPServers.setState({
      mcpServers: { quiet: { command: 'x', args: [], env: {}, active: true } },
    } as never)
    const t = new CoworkChatTransport('s1', coworkConfig())
    await t.refreshTools()
    expect(promptOf(t)).toContain('quiet (enabled, but it listed no tools')
  })

  it('says nothing while the tools are offered', async () => {
    turnOn('ida-multi-mcp', [ida])
    const t = new CoworkChatTransport('s1', coworkConfig())
    await t.refreshTools()
    expect(promptOf(t)).not.toContain('withheld')
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('switching a server back on in Settings re-enables its tools', () => {
    useMCPServers.setState({
      mcpServers: { 'ida-multi-mcp': { command: 'x', args: [], env: {}, active: false } },
    } as never)
    h.enableServerTools.mockClear()
    useMCPServers.setState({
      mcpServers: { 'ida-multi-mcp': { command: 'x', args: [], env: {}, active: true } },
    } as never)
    expect(h.enableServerTools).toHaveBeenCalledWith('ida-multi-mcp')
  })
})
