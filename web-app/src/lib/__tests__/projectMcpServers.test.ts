import { describe, it, expect, beforeEach } from 'vitest'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useThreadManagementStore } from '@/hooks/useThreadManagement'
import { useThreads } from '@/hooks/useThreads'
import {
  filterToolsByServers,
  projectMcpAllowList,
  threadMcpAllowList,
} from '@/lib/projectMcpServers'

const tools = [
  { name: 'a', server: 'alpha' },
  { name: 'b', server: 'beta' },
  { name: 'g', server: 'gamma' },
]

function setup(mcpServers?: string[]) {
  useMCPServers.setState({
    mcpServers: { alpha: {}, beta: {}, gamma: {} } as never,
  })
  useThreadManagementStore.setState({
    folders: [{ id: 'p1', name: 'P', updated_at: 0, ...(mcpServers ? { mcpServers } : {}) }],
  })
  useThreads.setState({
    threads: {
      inProject: { id: 'inProject', metadata: { project: { id: 'p1' } } },
      loose: { id: 'loose', metadata: {} },
    } as never,
  })
}

describe('project MCP server filter', () => {
  beforeEach(() => setup())

  it('defaults to every server', () => {
    expect(projectMcpAllowList('p1')).toBeNull()
    expect(filterToolsByServers(tools, threadMcpAllowList('inProject'))).toEqual(tools)
  })

  it('filters a project chat to the chosen servers', () => {
    setup(['beta'])
    const allow = threadMcpAllowList('inProject')
    expect(filterToolsByServers(tools, allow).map((t) => t.name)).toEqual(['b'])
  })

  it('leaves chats outside projects unchanged', () => {
    setup(['beta'])
    expect(threadMcpAllowList('loose')).toBeNull()
    expect(threadMcpAllowList(undefined)).toBeNull()
  })

  it('ignores a server removed from the global config', () => {
    setup(['beta', 'removed'])
    expect([...projectMcpAllowList('p1')!]).toEqual(['beta'])
  })

  it('an empty choice offers no MCP tools', () => {
    setup([])
    expect(filterToolsByServers(tools, threadMcpAllowList('inProject'))).toEqual([])
  })
})
