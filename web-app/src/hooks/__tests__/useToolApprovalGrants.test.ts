import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  selectPendingApprovalCount,
  usePendingApprovalCount,
  useToolApprovalRequests,
} from '../useToolApprovalRequests'
import { useToolApproval } from '../useToolApproval'
import { getServiceHub } from '@/hooks/useServiceHub'

// The persist layer is stubbed so no disk I/O happens; the backend MCP service
// is replaced per test. Everything here is mock-backed store behaviour, not a
// real Tauri round trip.
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

const withMcp = async (mcp: Record<string, unknown>, run: () => Promise<void>) => {
  const hub = getServiceHub() as unknown as Record<string, unknown>
  const real = hub.mcp
  hub.mcp = () => mcp as never
  try {
    await run()
  } finally {
    hub.mcp = real
  }
}

const request = (id: string, tool: string, thread: string, server?: string) =>
  useToolApprovalRequests.getState().requestApproval(id, tool, thread, server)

beforeEach(() => {
  useToolApprovalRequests.setState({ pending: {}, refusals: {} })
  useToolApproval.setState({
    approvedTools: {},
    approvedServers: [],
    approvedToolsGlobal: [],
    allowAllMCPPermissions: false,
  })
})

describe('grant reuse', () => {
  it('a thread grant covers the same tool in the same thread without a prompt', async () => {
    const first = request('tc1', 'bash', 'thread-1')
    useToolApprovalRequests.getState().resolveApproval('tc1', 'allow-thread')
    await expect(first).resolves.toBe(true)

    await expect(request('tc2', 'bash', 'thread-1')).resolves.toBe(true)
    expect(useToolApprovalRequests.getState().pending).toEqual({})
  })

  it('a thread grant does not cover another tool or another thread', () => {
    useToolApproval.getState().approveToolForThread('thread-1', 'bash')
    void request('tc1', 'write', 'thread-1')
    void request('tc2', 'bash', 'thread-2')
    expect(Object.keys(useToolApprovalRequests.getState().pending).sort()).toEqual(
      ['tc1', 'tc2']
    )
  })

  it('trusting a server covers its other tools in other threads', async () => {
    await withMcp({ trustServer: vi.fn().mockResolvedValue(undefined) }, async () => {
      const first = request('tc1', 'create_issue', 'thread-1', 'github')
      useToolApprovalRequests.getState().resolveApproval('tc1', 'allow-always')
      await expect(first).resolves.toBe(true)
      await expect(request('tc2', 'list_repos', 'thread-9', 'github')).resolves.toBe(
        true
      )
      expect(useToolApprovalRequests.getState().pending).toEqual({})
    })
  })

  it('allow-once leaves nothing behind, so the next call asks again', async () => {
    const first = request('tc1', 'bash', 'thread-1')
    useToolApprovalRequests.getState().resolveApproval('tc1', 'allow-once')
    await expect(first).resolves.toBe(true)
    void request('tc2', 'bash', 'thread-1')
    expect(useToolApprovalRequests.getState().pending.tc2).toBeDefined()
  })

  it('keeps the call input and context on the pending entry', () => {
    void useToolApprovalRequests
      .getState()
      .requestApproval('tc1', 'edit', 's1', undefined, {
        input: { path: 'a.ts' },
        workspaceLabel: '/x/Forma',
      })
    expect(useToolApprovalRequests.getState().pending.tc1).toMatchObject({
      input: { path: 'a.ts' },
      workspaceLabel: '/x/Forma',
    })
  })
})

describe('revocation', () => {
  it('revoking a thread grant makes that tool prompt again', () => {
    const approval = useToolApproval.getState()
    approval.approveToolForThread('thread-1', 'bash')
    approval.approveToolForThread('thread-1', 'write')
    approval.revokeToolForThread('thread-1', 'bash')
    expect(useToolApproval.getState().approvedTools).toEqual({
      'thread-1': ['write'],
    })
    void request('tc1', 'bash', 'thread-1')
    expect(useToolApprovalRequests.getState().pending.tc1).toBeDefined()
  })

  it('drops a conversation once its last grant is revoked', () => {
    const approval = useToolApproval.getState()
    approval.approveToolForThread('thread-1', 'bash')
    approval.revokeToolForThread('thread-1', 'bash')
    expect(useToolApproval.getState().approvedTools).toEqual({})
    approval.approveToolForThread('thread-2', 'a')
    approval.approveToolForThread('thread-2', 'b')
    useToolApproval.getState().revokeThread('thread-2')
    expect(useToolApproval.getState().approvedTools).toEqual({})
  })

  it('revokes a tool allowed everywhere', () => {
    useToolApproval.getState().approveToolEverywhere('bash')
    useToolApproval.getState().revokeToolEverywhere('bash')
    expect(useToolApproval.getState().isToolApproved('t', 'bash')).toBe(false)
  })

  it('turns off allow-all', () => {
    useToolApproval.getState().setAllowAllMCPPermissions(true)
    useToolApproval.getState().revokeAllowAllMCPPermissions()
    expect(useToolApproval.getState().allowAllMCPPermissions).toBe(false)
  })

  it('revokes server trust with the backend first, then locally', async () => {
    const revokeServer = vi.fn().mockResolvedValue(undefined)
    await withMcp({ revokeServer }, async () => {
      useToolApproval.getState().approveServer('github')
      await useToolApproval.getState().revokeServerTrust('github')
      expect(revokeServer).toHaveBeenCalledWith('github')
      expect(useToolApproval.getState().approvedServers).toEqual([])
    })
  })

  // Clearing the store after a backend failure would show the server revoked
  // while the gate that enforces trust still lets its calls through.
  it('keeps a server trusted locally when the backend refuses to revoke it', async () => {
    const revokeServer = vi.fn().mockRejectedValue(new Error('disk full'))
    await withMcp({ revokeServer }, async () => {
      useToolApproval.getState().approveServer('github')
      await expect(
        useToolApproval.getState().revokeServerTrust('github')
      ).rejects.toThrow('disk full')
      expect(useToolApproval.getState().approvedServers).toEqual(['github'])
    })
  })
})

describe('pending count', () => {
  it('counts per thread and overall, and follows decisions and cancellation', () => {
    const { result: all } = renderHook(() => usePendingApprovalCount())
    const { result: t1 } = renderHook(() => usePendingApprovalCount('thread-1'))

    act(() => {
      void request('a', 'bash', 'thread-1')
      void request('b', 'write', 'thread-1')
      void request('c', 'bash', 'thread-2')
    })
    expect(all.current).toBe(3)
    expect(t1.current).toBe(2)

    act(() => useToolApprovalRequests.getState().resolveApproval('a', 'deny'))
    expect(all.current).toBe(2)
    expect(t1.current).toBe(1)

    act(() => useToolApprovalRequests.getState().clearPendingForThread('thread-1'))
    expect(all.current).toBe(1)
    expect(t1.current).toBe(0)

    act(() => useToolApprovalRequests.getState().resolveApproval('c', 'allow-once'))
    expect(all.current).toBe(0)
  })

  it('does not count a request a standing grant answered', () => {
    useToolApproval.getState().approveToolEverywhere('bash')
    void request('a', 'bash', 'thread-1')
    expect(selectPendingApprovalCount(useToolApprovalRequests.getState())).toBe(0)
  })
})

describe('refusal reasons', () => {
  it('records a user denial and a cancelled prompt differently, once each', async () => {
    const denied = request('d', 'bash', 'thread-1')
    const cancelled = request('c', 'bash', 'thread-2')
    useToolApprovalRequests.getState().resolveApproval('d', 'deny')
    useToolApprovalRequests.getState().clearPendingForThread('thread-2')
    await expect(denied).resolves.toBe(false)
    await expect(cancelled).resolves.toBe(false)

    const store = useToolApprovalRequests.getState()
    expect(store.takeRefusal('d')).toBe('denied')
    expect(store.takeRefusal('c')).toBe('cancelled')
    expect(useToolApprovalRequests.getState().takeRefusal('d')).toBeUndefined()
  })

  it('records nothing for an allowed request', async () => {
    const p = request('ok', 'bash', 'thread-1')
    useToolApprovalRequests.getState().resolveApproval('ok', 'allow-once')
    await p
    expect(useToolApprovalRequests.getState().takeRefusal('ok')).toBeUndefined()
  })
})
