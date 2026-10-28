/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  mcp: {
    getConnectedServers: vi.fn(),
    getServerStatuses: vi.fn(),
    activateMCPServer: vi.fn(),
    deactivateMCPServer: vi.fn(),
    startMCPServer: vi.fn(),
    stopMCPServer: vi.fn(),
  },
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ mcp: () => h.mcp }),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/lib/mcpServerIdentity', () => ({
  resolveServerFingerprints: vi.fn(async () => ({})),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))
vi.mock('sonner', () => ({ toast: h.toast }))

import { useMcpServerLifecycle } from '../useMcpServerLifecycle'

const config: any = { command: 'node', args: [], env: {}, active: false }

const setup = () => {
  const editServer = vi.fn()
  const syncServers = vi.fn()
  const setErrorMessage = vi.fn()
  const refreshAuth = vi.fn()
  const mcpServers: any = { files: config }
  const hook = renderHook(() =>
    useMcpServerLifecycle({
      mcpServers,
      editServer,
      syncServers,
      getServerConfig: () => config,
      authorize: vi.fn() as any,
      clearAuth: vi.fn() as any,
      refreshAuth,
      setErrorMessage,
    })
  )
  return { hook, editServer, syncServers, setErrorMessage, refreshAuth }
}

describe('useMcpServerLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.mcp.getConnectedServers.mockResolvedValue([])
    h.mcp.getServerStatuses.mockResolvedValue({})
    h.mcp.activateMCPServer.mockResolvedValue(undefined)
    h.mcp.deactivateMCPServer.mockResolvedValue(undefined)
  })

  it('toggle on starts the server and marks it connected once the backend lists it', async () => {
    h.mcp.getConnectedServers.mockResolvedValue(['files'])
    const { hook, editServer, syncServers } = setup()
    await act(async () => {
      await hook.result.current.toggleServer('files', true)
    })
    expect(h.mcp.activateMCPServer).toHaveBeenCalledWith('files', {
      ...config,
      active: true,
    })
    expect(editServer).toHaveBeenCalledWith('files', { ...config, active: true })
    expect(syncServers).toHaveBeenCalled()
    expect(hook.result.current.connectedServers).toContain('files')
    expect(h.toast.success).toHaveBeenCalled()
    expect(hook.result.current.loadingServers.files).toBe(false)
  })

  it('toggle on failure surfaces the error and switches the server back off', async () => {
    h.mcp.activateMCPServer.mockRejectedValue(new Error('spawn failed'))
    const { hook, editServer, setErrorMessage } = setup()
    await act(async () => {
      await hook.result.current.toggleServer('files', true)
    })
    expect(editServer).toHaveBeenCalledWith('files', {
      ...config,
      active: false,
    })
    expect(setErrorMessage).toHaveBeenCalledTimes(1)
    expect(hook.result.current.runtime.files?.failure).toBeTruthy()
  })

  it('a server absent from the connected list after start is not confirmed', async () => {
    h.mcp.getConnectedServers.mockResolvedValue([])
    const { hook, editServer } = setup()
    await act(async () => {
      await hook.result.current.toggleServer('files', true)
    })
    expect(editServer).not.toHaveBeenCalledWith('files', {
      ...config,
      active: true,
    })
    expect(h.mcp.deactivateMCPServer).toHaveBeenCalledWith('files')
  })

  it('toggle off deactivates and saves the flag', async () => {
    const { hook, editServer } = setup()
    await act(async () => {
      await hook.result.current.toggleServer('files', false)
    })
    expect(h.mcp.deactivateMCPServer).toHaveBeenCalledWith('files')
    expect(editServer).toHaveBeenCalledWith('files', {
      ...config,
      active: false,
    })
    await waitFor(() =>
      expect(hook.result.current.loadingServers.files).toBe(false)
    )
  })
})
