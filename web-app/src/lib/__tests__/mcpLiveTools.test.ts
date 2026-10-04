import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useMCPServers } from '@/hooks/useMCPServers'
import {
  bumpMcpGeneration,
  diffMcpSnapshots,
  getMcpGeneration,
  loadLiveMcpTools,
  mcpChangeNote,
  mcpServerLabels,
  mcpServersLine,
  mcpStartingNote,
  snapshotMcpTools,
} from '../mcpLiveTools'

const tool = (name: string, server: string) => ({
  name,
  server,
  description: '',
  inputSchema: {},
})

describe('the MCP tool-set generation counter', () => {
  beforeEach(() => {
    useMCPServers.setState({ mcpServers: {} } as never)
    bumpMcpGeneration()
  })

  it('moves on an explicit bump', () => {
    const before = getMcpGeneration()
    bumpMcpGeneration()
    expect(getMcpGeneration()).toBe(before + 1)
  })

  it('moves when a server is switched on or off in Settings, not on an unrelated edit', () => {
    const start = getMcpGeneration()
    useMCPServers.setState({
      mcpServers: { a: { command: 'x', args: [], env: {}, active: true } },
    } as never)
    expect(getMcpGeneration()).toBe(start + 1)

    // Same active set, different args: nothing to re-read.
    useMCPServers.setState({
      mcpServers: { a: { command: 'y', args: [], env: {}, active: true } },
    } as never)
    expect(getMcpGeneration()).toBe(start + 1)

    useMCPServers.setState({
      mcpServers: { a: { command: 'y', args: [], env: {}, active: false } },
    } as never)
    expect(getMcpGeneration()).toBe(start + 2)
  })
})

describe('loadLiveMcpTools', () => {
  beforeEach(() => {
    useMCPServers.setState({ mcpServers: {} } as never)
    bumpMcpGeneration()
  })
  afterEach(() => vi.useRealTimers())

  it('lists once while the generation is unchanged, and again after a bump', async () => {
    const getTools = vi.fn(async () => [tool('t1', 'a')])
    await loadLiveMcpTools({ getTools })
    await loadLiveMcpTools({ getTools })
    expect(getTools).toHaveBeenCalledTimes(1)
    expect(getTools).toHaveBeenCalledWith({ start: true })

    bumpMcpGeneration()
    getTools.mockResolvedValue([tool('t1', 'a'), tool('t2', 'b')] as never)
    const live = await loadLiveMcpTools({ getTools })
    expect(getTools).toHaveBeenCalledTimes(2)
    expect(live.tools.map((t) => t.name)).toEqual(['t1', 't2'])
  })

  it('shares one listing between concurrent callers', async () => {
    const getTools = vi.fn(async () => [tool('t1', 'a')])
    await Promise.all([
      loadLiveMcpTools({ getTools }),
      loadLiveMcpTools({ getTools }),
    ])
    expect(getTools).toHaveBeenCalledTimes(1)
  })

  it('reports a server still starting instead of blocking past the wait', async () => {
    useMCPServers.setState({
      mcpServers: {
        slow: { command: 'x', args: [], env: {}, active: true },
        fast: { command: 'x', args: [], env: {}, active: true },
      },
    } as never)
    const getTools = vi.fn(async (opts?: { start?: boolean }) =>
      opts?.start
        ? new Promise<never[]>(() => undefined)
        : [tool('f1', 'fast')]
    )
    const live = await loadLiveMcpTools({ getTools }, { waitMs: 5 })
    expect(live.tools.map((t) => t.name)).toEqual(['f1'])
    expect(live.starting).toEqual(['slow'])
    expect(mcpStartingNote(live.starting)).toMatch(/slow is still starting/)
  })

  it('does not cache a listing that had servers still starting', async () => {
    useMCPServers.setState({
      mcpServers: { slow: { command: 'x', args: [], env: {}, active: true } },
    } as never)
    const getTools = vi.fn(async (opts?: { start?: boolean }) =>
      opts?.start ? new Promise<never[]>(() => undefined) : []
    )
    await loadLiveMcpTools({ getTools }, { waitMs: 1 })
    await loadLiveMcpTools({ getTools }, { waitMs: 1 })
    expect(getTools.mock.calls.filter(([o]) => o?.start)).toHaveLength(2)
  })
})

describe('the changed note and the environment line', () => {
  it('names a server that appeared, with its tool count', () => {
    const change = diffMcpSnapshots(
      {},
      snapshotMcpTools([tool('a', 'ida-multi-mcp'), tool('b', 'ida-multi-mcp')])
    )
    expect(mcpChangeNote(change)).toMatch(
      /^MCP servers changed: ida-multi-mcp is now available \(2 tools\)\./
    )
  })

  it('names a server that went away and one whose tools changed', () => {
    const change = diffMcpSnapshots(
      snapshotMcpTools([tool('a', 'foo'), tool('b', 'bar')]),
      snapshotMcpTools([tool('a', 'foo'), tool('c', 'foo')])
    )
    const note = mcpChangeNote(change) as string
    expect(note).toContain('foo now offers 2 tools (was 1)')
    expect(note).toContain('bar was removed')
  })

  it('says nothing when the set is the same, whatever the order', () => {
    const a = snapshotMcpTools([tool('x', 's'), tool('y', 's')])
    const b = snapshotMcpTools([tool('y', 's'), tool('x', 's')])
    expect(mcpChangeNote(diffMcpSnapshots(a, b))).toBeNull()
  })

  it('never says "none" while a server is connected or starting', () => {
    const connected = snapshotMcpTools([tool('a', 'ida-multi-mcp')])
    expect(mcpServersLine(connected)).toBe(
      'MCP servers in this session: ida-multi-mcp (1 tool).'
    )
    expect(mcpServersLine({}, ['late'])).toContain('late (still starting')
    expect(mcpServersLine({}, ['late'])).not.toContain('none')
    expect(mcpServerLabels(connected, ['ida-multi-mcp'])).toHaveLength(1)
  })

  it('says none only when there really are no servers', () => {
    expect(mcpServersLine({})).toBe('MCP servers in this session: none.')
  })
})
