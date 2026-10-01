import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { TauriMCPService } from '../tauri'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const mockCore = { api: { getTools: vi.fn() } }
Object.defineProperty(globalThis, 'window', {
  value: { core: mockCore },
  writable: true,
})

describe('TauriMCPService – on-demand start', () => {
  let svc: TauriMCPService
  beforeEach(() => {
    svc = new TauriMCPService()
    vi.clearAllMocks()
  })

  it('a plain listing does not ask the backend to start servers', async () => {
    mockCore.api.getTools.mockResolvedValue([])
    await svc.getTools()
    expect(mockCore.api.getTools).toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('a send listing passes start', async () => {
    vi.mocked(invoke).mockResolvedValue([])
    await svc.getTools({ start: true })
    expect(invoke).toHaveBeenCalledWith('get_tools', { start: true })
    await svc.getToolsForServers(['a'], { start: true })
    expect(invoke).toHaveBeenCalledWith('get_tools_for_servers', {
      serverNames: ['a'],
      start: true,
    })
    await svc.getToolsForServers(['a'])
    expect(invoke).toHaveBeenLastCalledWith('get_tools_for_servers', {
      serverNames: ['a'],
    })
  })

  it('enable-only activation, manual start/stop and statuses', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    const config = { command: 'npx', args: [], env: {} }
    await svc.activateMCPServer('a', config, { start: false })
    expect(invoke).toHaveBeenCalledWith('activate_mcp_server', {
      name: 'a',
      config,
      start: false,
    })
    await svc.startMCPServer('a')
    expect(invoke).toHaveBeenCalledWith('start_mcp_server_now', { name: 'a' })
    await svc.stopMCPServer('a')
    expect(invoke).toHaveBeenCalledWith('stop_mcp_server_now', { name: 'a' })
    vi.mocked(invoke).mockResolvedValue({ a: { state: 'stopped' } })
    expect(await svc.getServerStatuses()).toEqual({ a: { state: 'stopped' } })
  })
})
