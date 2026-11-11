import { describe, it, expect, vi, beforeEach } from 'vitest'

// The browser build `flint serve` serves has no tool executor: a room there
// must not advertise file tools it cannot run, and must say why.
let served = false
vi.mock('@/lib/platform/utils', () => ({ isServedByFlint: () => served }))

const getAgentToolSchemas = vi.fn()
vi.mock('@/lib/agentTools', () => ({
  getAgentToolSchemas: (...a: unknown[]) => getAgentToolSchemas(...a),
  executeAgentTool: vi.fn(),
}))
vi.mock('@/hooks/useWebSearchConfig', () => ({
  useWebSearchConfig: { getState: () => ({ webSearchEnabled: true }) },
}))
vi.mock('@/hooks/useVisualizeConfig', () => ({
  useVisualizeConfig: { getState: () => ({ enabled: false }) },
}))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  directEditAuthorize: vi.fn(async () => 'grant'),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    app: () => ({ getJanDataFolder: async () => '/data' }),
    mcp: () => ({
      getTools: async () => [],
      callTool: vi.fn(),
      cancelToolCall: vi.fn(),
      trustReport: async () => ({ trusted: [], invalidated: [] }),
      getMCPConfig: async () => ({ mcpServers: {} }),
    }),
  }),
}))
vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: { getState: () => ({ isToolDisabled: () => false }) },
}))
vi.mock('@/lib/extensionsStore', () => ({ resolveExtensions: vi.fn(async () => []) }))
vi.mock('@/lib/skillStore', () => ({
  readSkill: vi.fn(async () => ''),
  storeScope: { kind: 'store' },
}))

import { buildRoomTools } from '../roomTools'
import { loadRoomToolCatalog, roomFileToolsAvailable } from '../toolCatalog'
import { buildSystemPrompt } from '../context'
import { makeRoom } from './helpers'

const schema = (name: string) => ({
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
})

describe('a room participant with a folder', () => {
  beforeEach(() => {
    getAgentToolSchemas.mockReset()
    getAgentToolSchemas.mockResolvedValue(['read', 'ls', 'find', 'grep'].map(schema))
  })

  it('gets the read tools in the desktop app', async () => {
    served = false
    expect(roomFileToolsAvailable()).toBe(true)
    const tools = await buildRoomTools({ roomId: 'r1', folder: '/work', access: 'read' })
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['read', 'ls', 'find', 'grep']))
  })

  it('gets no file tools, and asks for none, on the served browser build', async () => {
    served = true
    expect(roomFileToolsAvailable()).toBe(false)
    const tools = await buildRoomTools({ roomId: 'r1', folder: '/work', access: 'read' })
    expect(Object.keys(tools)).not.toContain('read')
    expect(Object.keys(tools)).toContain('web_search')
    expect(getAgentToolSchemas).not.toHaveBeenCalled()
    const catalog = await loadRoomToolCatalog('/work', 'read')
    expect(catalog.some((e) => e.group === 'files')).toBe(false)
  })
})

describe('the prompt of a reader on the served browser build', () => {
  it('says the folder cannot be read there instead of promising file tools', () => {
    served = true
    const room = makeRoom({ folder: '/work', mode: 'round-robin' })
    const speaker = {
      kind: 'participant' as const,
      participant: { ...room.participants[0], toolAccess: 'read' as const },
    }
    const s = buildSystemPrompt(room, speaker)
    expect(s).toContain('only run in the Flint desktop app')
    expect(s).not.toContain('You can read and list files')
    served = false
    expect(buildSystemPrompt(room, speaker)).toContain('You can read and list files')
  })
})
