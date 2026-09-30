import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastFn = vi.hoisted(() => {
  const t = vi.fn() as ReturnType<typeof vi.fn> & {
    success: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
  t.success = vi.fn()
  t.error = vi.fn()
  return t
})
vi.mock('sonner', () => ({ toast: toastFn }))

const mcp = vi.hoisted(() => ({
  getConnectedServers: vi.fn(),
  activateMCPServer: vi.fn(),
  deactivateMCPServer: vi.fn(),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ mcp: () => mcp }),
}))

import {
  enableMcpServer,
  offerToEnableMentionedServers,
  offServersMentioned,
  resetMcpMentionMemory,
} from '../mcpMention'
import { useMCPServers, type MCPServers } from '@/hooks/useMCPServers'

const cfg = (active = false) => ({ command: 'x', args: [], env: {}, active })
const servers: MCPServers = {
  notion: cfg(),
  'ida-multi-mcp': cfg(),
  'web search': cfg(true),
}

beforeEach(() => {
  toastFn.mockReset()
  toastFn.success.mockReset()
  toastFn.error.mockReset()
  mcp.getConnectedServers.mockReset()
  mcp.activateMCPServer.mockReset().mockResolvedValue(undefined)
  mcp.deactivateMCPServer.mockReset().mockResolvedValue(undefined)
  resetMcpMentionMemory()
  useMCPServers.setState({
    mcpServers: servers,
    editServer: vi.fn(),
    syncServers: vi.fn().mockResolvedValue(undefined),
  } as never)
})

describe('offServersMentioned', () => {
  it('names a configured server that is not connected', () => {
    expect(offServersMentioned('use the ida-multi-mcp tools on this binary', servers, [])).toEqual([
      'ida-multi-mcp',
    ])
    expect(offServersMentioned('check it with the notion server', servers, [])).toEqual(['notion'])
  })

  it('ignores a server that is already connected', () => {
    expect(offServersMentioned('use the notion server', servers, ['notion'])).toEqual([])
  })

  it('does not fire on an ordinary word that happens to be a server name', () => {
    expect(offServersMentioned('take some notion of the plan', servers, [])).toEqual([])
  })

  it('ignores a server that is not configured at all', () => {
    expect(offServersMentioned('use the github server', servers, [])).toEqual([])
  })
})

describe('offerToEnableMentionedServers', () => {
  it('offers once, with an Enable action, for an off server that was named', async () => {
    mcp.getConnectedServers.mockResolvedValue([])
    await offerToEnableMentionedServers('use the notion server for this')
    expect(toastFn).toHaveBeenCalledTimes(1)
    expect(toastFn.mock.calls[0][1]).toMatchObject({ action: expect.any(Object) })
    // Not asked again this session for the same server.
    await offerToEnableMentionedServers('and the notion server again')
    expect(toastFn).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a slash command, an empty message, or when nothing is off', async () => {
    mcp.getConnectedServers.mockResolvedValue([])
    await offerToEnableMentionedServers('/notion server')
    await offerToEnableMentionedServers('   ')
    mcp.getConnectedServers.mockResolvedValue(['notion', 'ida-multi-mcp'])
    await offerToEnableMentionedServers('use the notion server')
    expect(toastFn).not.toHaveBeenCalled()
  })

  it('never throws, whatever the backend does', async () => {
    mcp.getConnectedServers.mockRejectedValue(new Error('backend down'))
    await expect(offerToEnableMentionedServers('use the notion server')).resolves.toBeUndefined()
    expect(toastFn).not.toHaveBeenCalled()
  })

  it('enables nothing until the user presses the action', async () => {
    mcp.getConnectedServers.mockResolvedValue([])
    await offerToEnableMentionedServers('use the notion server for this')
    expect(mcp.activateMCPServer).not.toHaveBeenCalled()

    mcp.getConnectedServers.mockResolvedValue(['notion'])
    toastFn.mock.calls[0][1].action.onClick()
    await vi.waitFor(() => expect(toastFn.success).toHaveBeenCalled())
    expect(mcp.activateMCPServer).toHaveBeenCalledWith(
      'notion',
      expect.objectContaining({ active: true })
    )
  })
})

describe('enableMcpServer', () => {
  it('saves the server as on only once the backend lists it as connected', async () => {
    mcp.getConnectedServers.mockResolvedValue(['notion'])
    await enableMcpServer('notion')
    expect(useMCPServers.getState().editServer).toHaveBeenCalledWith(
      'notion',
      expect.objectContaining({ active: true })
    )
  })

  it('stops a server that started but never connected, and reports it', async () => {
    mcp.getConnectedServers.mockResolvedValue([])
    await expect(enableMcpServer('notion')).rejects.toThrow()
    expect(mcp.deactivateMCPServer).toHaveBeenCalledWith('notion')
    expect(useMCPServers.getState().editServer).not.toHaveBeenCalled()
  })

  it('refuses a server that is not configured', async () => {
    await expect(enableMcpServer('nope')).rejects.toThrow(/nope/)
  })
})
