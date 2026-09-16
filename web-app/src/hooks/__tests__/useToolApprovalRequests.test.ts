import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useToolApprovalRequests } from '../useToolApprovalRequests'
import { useToolApproval } from '../useToolApproval'
import { getServiceHub } from '@/hooks/useServiceHub'

// useToolApproval persists via backendStorage; stub the persist layer so the
// import is inert and no disk I/O happens in tests.
vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { toolApproval: 'tool-approval-settings' },
}))
vi.mock('zustand/middleware', () => ({
  persist: (fn: any) => fn,
  createJSONStorage: () => ({
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }),
}))

describe('useToolApprovalRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useToolApprovalRequests.setState({ pending: {}, approvedFingerprints: {} })
    useToolApproval.setState({
      approvedTools: {},
      approvedMcpTools: {},
      approvedServers: [],
      approvedToolsGlobal: [],
      invalidatedServers: [],
      allowAllMCPPermissions: false,
    })
  })

  // What `mcp_server_fingerprints` reports for the server in these tests.
  const GH = { serverFingerprint: 'sha256:gh' }

  it('stores a pending approval keyed by toolCallId', () => {
    const { result } = renderHook(() => useToolApprovalRequests())

    act(() => {
      result.current.requestApproval('tc1', 'tool-a', 'thread-1')
    })

    expect(result.current.pending['tc1']).toMatchObject({
      toolCallId: 'tc1',
      toolName: 'tool-a',
      threadId: 'thread-1',
    })
  })

  it('auto-resolves true (no pending) when allowAllMCPPermissions is set for a server tool', async () => {
    useToolApproval.setState({ allowAllMCPPermissions: true })
    const { result } = renderHook(() => useToolApprovalRequests())

    let p: Promise<boolean>
    act(() => {
      p = result.current.requestApproval('tc1', 'tool-a', 'thread-1', 'github', GH)
    })

    await expect(p!).resolves.toBe(true)
    expect(result.current.pending['tc1']).toBeUndefined()
  })

  it('allow-all does NOT auto-approve a built-in tool with no server (must be asked)', () => {
    // "Allow all MCP permissions" is an MCP setting; a server-less agent tool
    // (write/edit/bash) still has to be approved in Ask mode.
    useToolApproval.setState({ allowAllMCPPermissions: true })
    const { result } = renderHook(() => useToolApprovalRequests())

    act(() => {
      void result.current.requestApproval('tc-write', 'write', 'thread-1')
    })

    expect(result.current.pending['tc-write']).toBeDefined()
  })

  it('auto-resolves true (no pending) when the tool is already approved for the thread', async () => {
    act(() => {
      useToolApproval.getState().approveToolForThread('thread-1', 'tool-a')
    })
    const { result } = renderHook(() => useToolApprovalRequests())

    let p: Promise<boolean>
    act(() => {
      p = result.current.requestApproval('tc1', 'tool-a', 'thread-1')
    })

    await expect(p!).resolves.toBe(true)
    expect(result.current.pending['tc1']).toBeUndefined()
  })

  it('resolveApproval allow-once resolves true without persisting the tool', async () => {
    const { result } = renderHook(() => useToolApprovalRequests())

    let p: Promise<boolean>
    act(() => {
      p = result.current.requestApproval('tc1', 'tool-a', 'thread-1')
    })
    act(() => {
      result.current.resolveApproval('tc1', 'allow-once')
    })

    await expect(p!).resolves.toBe(true)
    expect(useToolApproval.getState().isToolApproved('thread-1', 'tool-a')).toBe(false)
    expect(result.current.pending['tc1']).toBeUndefined()
  })

  it('resolveApproval allow-thread persists the tool for that thread only', async () => {
    const { result } = renderHook(() => useToolApprovalRequests())

    let p: Promise<boolean>
    act(() => {
      p = result.current.requestApproval('tc1', 'tool-a', 'thread-1')
    })
    act(() => {
      result.current.resolveApproval('tc1', 'allow-thread')
    })

    await expect(p!).resolves.toBe(true)
    const approval = useToolApproval.getState()
    expect(approval.isToolApproved('thread-1', 'tool-a')).toBe(true)
    expect(approval.isToolApproved('thread-2', 'tool-a')).toBe(false)
  })

  // "Always" has to mean always, which is what the thread scope could not say.
  it('resolveApproval allow-always trusts the whole server, in every thread', async () => {
    const { result } = renderHook(() => useToolApprovalRequests())

    let p: Promise<boolean>
    act(() => {
      p = result.current.requestApproval('tc1', 'tool-a', 'thread-1', 'github', GH)
    })
    act(() => {
      result.current.resolveApproval('tc1', 'allow-always')
    })

    await expect(p!).resolves.toBe(true)
    const approval = useToolApproval.getState()
    expect(
      approval.isToolApproved('thread-2', 'other-tool', 'github', 'sha256:gh')
    ).toBe(true)
    expect(
      approval.isToolApproved('thread-2', 'tool-a', 'gitlab', 'sha256:gh')
    ).toBe(false)
    // Bound to the definition shown, not the name.
    expect(
      approval.isToolApproved('thread-2', 'other-tool', 'github', 'sha256:changed')
    ).toBe(false)
  })

  // AH-041. Renderer state is what the prompt reads; the backend is what the
  // gate reads. An answer that updated only the first would be forgotten by the
  // thing that actually enforces it, and the user would be asked again with no
  // explanation.
  it('records an allow-always server with the backend, not only in the store', async () => {
    const trustServer = vi.fn().mockResolvedValue(undefined)
    const hub = getServiceHub() as unknown as Record<string, unknown>
    const realMcp = hub.mcp
    hub.mcp = () => ({ trustServer }) as never
    try {
      const { result } = renderHook(() => useToolApprovalRequests())
      let p: Promise<boolean>
      act(() => {
        p = result.current.requestApproval('tc9', 'tool-a', 'thread-1', 'github', GH)
      })
      act(() => {
        result.current.resolveApproval('tc9', 'allow-always')
      })
      await expect(p!).resolves.toBe(true)
      expect(trustServer).toHaveBeenCalledWith('github', 'sha256:gh')
    } finally {
      hub.mcp = realMcp
    }
  })

  it('resolveApproval allow-always falls back to the tool when it has no server', async () => {
    const { result } = renderHook(() => useToolApprovalRequests())

    let p: Promise<boolean>
    act(() => {
      p = result.current.requestApproval('tc1', 'tool-a', 'thread-1')
    })
    act(() => {
      result.current.resolveApproval('tc1', 'allow-always')
    })

    await expect(p!).resolves.toBe(true)
    const approval = useToolApproval.getState()
    expect(approval.isToolApproved('thread-2', 'tool-a')).toBe(true)
    expect(approval.isToolApproved('thread-2', 'tool-b')).toBe(false)
  })

  it('auto-resolves true when the tool comes from an already trusted server', async () => {
    act(() => {
      useToolApproval.getState().approveServer('github', 'sha256:gh')
    })
    const { result } = renderHook(() => useToolApprovalRequests())

    let p: Promise<boolean>
    act(() => {
      p = result.current.requestApproval('tc1', 'tool-a', 'thread-1', 'github', GH)
    })

    await expect(p!).resolves.toBe(true)
    expect(result.current.pending['tc1']).toBeUndefined()
  })

  it('keeps the server and its definition on the pending entry so the prompt can name it', async () => {
    const { result } = renderHook(() => useToolApprovalRequests())

    act(() => {
      void result.current.requestApproval('tc1', 'tool-a', 'thread-1', 'github', GH)
    })

    expect(result.current.pending['tc1']).toMatchObject({
      serverName: 'github',
      serverFingerprint: 'sha256:gh',
    })
  })

  it('looks up the server definition when the caller does not supply it', async () => {
    const { result } = renderHook(() => useToolApprovalRequests())
    const hub = getServiceHub() as unknown as Record<string, unknown>
    const realMcp = hub.mcp
    hub.mcp = () =>
      ({ serverFingerprints: vi.fn().mockResolvedValue({ github: 'sha256:gh' }) }) as never
    try {
      act(() => {
        void result.current.requestApproval('tc1', 'tool-a', 'thread-1', 'github')
      })
      await vi.waitFor(() =>
        expect(useToolApprovalRequests.getState().pending['tc1']).toMatchObject({
          serverName: 'github',
          serverFingerprint: 'sha256:gh',
        })
      )
    } finally {
      hub.mcp = realMcp
    }
  })

  it('resolveApproval deny resolves false', async () => {
    const { result } = renderHook(() => useToolApprovalRequests())

    let p: Promise<boolean>
    act(() => {
      p = result.current.requestApproval('tc1', 'tool-a', 'thread-1')
    })
    act(() => {
      result.current.resolveApproval('tc1', 'deny')
    })

    await expect(p!).resolves.toBe(false)
    expect(useToolApproval.getState().isToolApproved('thread-1', 'tool-a')).toBe(false)
  })

  it('clearPendingForThread resolves matching promises false and removes only that thread', async () => {
    const { result } = renderHook(() => useToolApprovalRequests())

    let pA: Promise<boolean>
    let pB: Promise<boolean>
    act(() => {
      pA = result.current.requestApproval('tcA', 'tool-a', 'thread-A')
      pB = result.current.requestApproval('tcB', 'tool-b', 'thread-B')
    })

    act(() => {
      result.current.clearPendingForThread('thread-A')
    })

    await expect(pA!).resolves.toBe(false)
    expect(result.current.pending['tcA']).toBeUndefined()
    expect(result.current.pending['tcB']).toMatchObject({ threadId: 'thread-B' })

    act(() => {
      result.current.resolveApproval('tcB', 'allow-once')
    })
    await expect(pB!).resolves.toBe(true)
  })

  it('clearPendingForThread is a no-op when nothing matches', () => {
    const { result } = renderHook(() => useToolApprovalRequests())

    act(() => {
      result.current.requestApproval('tcA', 'tool-a', 'thread-A')
    })
    act(() => {
      result.current.clearPendingForThread('thread-Z')
    })

    expect(result.current.pending['tcA']).toMatchObject({ threadId: 'thread-A' })
  })
})
