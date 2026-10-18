import { describe, it, expect, vi, beforeEach } from 'vitest'

const getTools = vi.fn()
const getMCPConfig = vi.fn()
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    mcp: () => ({
      getTools,
      getMCPConfig,
      trustReport: async () => ({
        trusted: ['running', 'idle', 'off'].map((name) => ({ name, fingerprint: 'fp', currentFingerprint: 'fp' })),
        invalidated: [],
      }),
    }),
  }),
}))
vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: { getState: () => ({ isToolDisabled: () => false }) },
}))
vi.mock('@/hooks/useWebSearchConfig', () => ({
  useWebSearchConfig: { getState: () => ({ webSearchEnabled: false }) },
}))
vi.mock('@/hooks/useVisualizeConfig', () => ({
  useVisualizeConfig: { getState: () => ({ enabled: false }) },
}))

import { disabledMcpServers, loadRoomToolCatalog, mcpServerKey } from '../toolCatalog'

beforeEach(() => {
  getTools.mockReset().mockResolvedValue([
    { name: 'run_tool', description: 'r', inputSchema: { type: 'object' }, server: 'running' },
  ])
  getMCPConfig.mockReset().mockResolvedValue({
    mcpServers: {
      running: { command: 'x', args: [], env: {}, active: true },
      idle: { command: 'x', args: [], env: {}, active: true },
      off: { command: 'x', args: [], env: {}, active: false },
      untrusted: { command: 'x', args: [], env: {}, active: true },
    },
  })
})

describe('the room tool picker and MCP servers that are not started', () => {
  it('lists a configured, trusted server that is not running, without starting anything', async () => {
    const entries = await loadRoomToolCatalog(null, 'read')
    const mcp = entries.filter((e) => e.group === 'mcp')
    expect(mcp).toEqual([
      expect.objectContaining({ name: 'run_tool', server: 'running' }),
      { name: mcpServerKey('idle'), group: 'mcp', tokens: 0, server: 'idle', notStarted: true },
    ])
    // Only the plain listing: no `start` flag.
    expect(getTools).toHaveBeenCalledTimes(1)
    expect(getTools.mock.calls[0]).toEqual([])
  })

  it('reads a whole-server switch back out of disabledTools', () => {
    expect([...disabledMcpServers(['read', 'mcp:idle'])]).toEqual(['idle'])
    expect(disabledMcpServers(undefined).size).toBe(0)
  })
})
