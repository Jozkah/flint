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
      approvedSimilarCalls: [],
      invalidatedServers: [],
      allowAllMCPPermissions: false,
      permissionMode: 'ask',
    })
  })

  // What `mcp_server_fingerprints` reports for the server in these tests.
  const GH = { serverFingerprint: 'sha256:gh' }

  it('auto-approves safe built-in and MCP calls in auto mode', async () => {
    useToolApproval.setState({ permissionMode: 'auto-approve' })
    await expect(
      useToolApprovalRequests
        .getState()
        .requestApproval('safe-1', 'read', 'thread-1')
    ).resolves.toBe(true)
    await expect(
      useToolApprovalRequests
        .getState()
        .requestApproval('safe-2', 'search', 'thread-1', 'search-server', GH)
    ).resolves.toBe(true)
    expect(useToolApprovalRequests.getState().pending).toEqual({})
  })

  it('asks before dangerous calls in auto mode', () => {
    useToolApproval.setState({
      permissionMode: 'auto-approve',
      allowAllMCPPermissions: true,
      approvedToolsGlobal: ['bash'],
    })
    void useToolApprovalRequests
      .getState()
      .requestApproval('danger-1', 'bash', 'thread-1', undefined, {
        input: { command: 'rm -rf /' },
        workspaceRoots: ['/home/user/project'],
      })
    void useToolApprovalRequests
      .getState()
      .requestApproval('danger-2', 'host_powershell', 'thread-1', undefined, {
        input: { script: 'Stop-Process -Id 42' },
        alwaysAsk: true,
      })
    void useToolApprovalRequests
      .getState()
      .requestApproval('danger-3', 'files', 'thread-1', 'connected-files', {
        ...GH,
        input: { action: 'delete' },
      })
    expect(useToolApprovalRequests.getState().pending['danger-1']).toBeDefined()
    expect(useToolApprovalRequests.getState().pending['danger-2']).toBeDefined()
    expect(useToolApprovalRequests.getState().pending['danger-3']).toBeDefined()
  })

  it('bypass mode answers always-ask calls without a prompt', async () => {
    useToolApproval.setState({ permissionMode: 'bypass' })
    await expect(
      useToolApprovalRequests
        .getState()
        .requestApproval('bypass-1', 'host_powershell', 'thread-1', undefined, {
          input: { script: 'Stop-Process -Id 42' },
          alwaysAsk: true,
        })
    ).resolves.toBe(true)
    expect(useToolApprovalRequests.getState().pending).toEqual({})
  })

  it('remembers a narrow process-stop rule across different IDs', async () => {
    const first = useToolApprovalRequests.getState().requestApproval(
      'stop-42', 'host_powershell', 'thread-process', undefined,
      { input: { script: 'Stop-Process -Id 42' }, alwaysAsk: true }
    )
    expect(useToolApprovalRequests.getState().pending['stop-42']).toBeDefined()
    useToolApprovalRequests.getState().resolveApproval('stop-42', 'allow-always')
    await expect(first).resolves.toBe(true)
    expect(useToolApproval.getState().approvedSimilarCalls).toHaveLength(1)

    await expect(useToolApprovalRequests.getState().requestApproval(
      'stop-99', 'host_powershell', 'thread-process', undefined,
      { input: { script: 'Stop-Process -Id 99' }, alwaysAsk: true }
    )).resolves.toBe(true)
    expect(useToolApprovalRequests.getState().pending['stop-99']).toBeUndefined()

    void useToolApprovalRequests.getState().requestApproval(
      'other-script', 'host_powershell', 'thread-process', undefined,
      { input: { script: 'Stop-Process -Id 99; Remove-Item C:\\data' }, alwaysAsk: true }
    )
    expect(useToolApprovalRequests.getState().pending['other-script']).toBeDefined()

    useToolApproval.getState().revokeSimilarCall('host_powershell:stop-process-id')
    void useToolApprovalRequests.getState().requestApproval(
      'stop-after-revoke', 'host_powershell', 'thread-process', undefined,
      { input: { script: 'Stop-Process -Id 100' }, alwaysAsk: true }
    )
    expect(useToolApprovalRequests.getState().pending['stop-after-revoke']).toBeDefined()
  })

  it('applies a process-kill grant only to host_action kill_process', async () => {
    const first = useToolApprovalRequests.getState().requestApproval(
      'kill-42', 'host_action', 'thread-host-action', undefined,
      { input: { action: 'kill_process', pid: 42 }, alwaysAsk: true }
    )
    useToolApprovalRequests.getState().resolveApproval('kill-42', 'allow-always')
    await first
    await expect(useToolApprovalRequests.getState().requestApproval(
      'kill-99', 'host_action', 'thread-host-action', undefined,
      { input: { action: 'kill_process', pid: 99 }, alwaysAsk: true }
    )).resolves.toBe(true)
    void useToolApprovalRequests.getState().requestApproval(
      'stop-service', 'host_action', 'thread-host-action', undefined,
      { input: { action: 'stop_service', name: 'Example' }, alwaysAsk: true }
    )
    expect(useToolApprovalRequests.getState().pending['stop-service']).toBeDefined()
  })

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
      p = result.current.requestApproval(
        'tc1',
        'tool-a',
        'thread-1',
        'github',
        GH
      )
    })

    await expect(p!).resolves.toBe(true)
    expect(result.current.pending['tc1']).toBeUndefined()
  })

  it('never auto-approves a tool that approves commands on its own server', () => {
    // super-shell's `approve_command` would let the model answer for the
    // user: allow-all, a trusted server and an "always" grant all miss it.
    useToolApproval.setState({
      allowAllMCPPermissions: true,
      approvedToolsGlobal: ['approve_command'],
    })
    const { result } = renderHook(() => useToolApprovalRequests())

    act(() => {
      void result.current.requestApproval(
        'tc-self',
        'approve_command',
        'thread-1',
        'super-shell',
        GH
      )
    })

    const pending = result.current.pending['tc-self']
    expect(pending).toBeDefined()
    expect(pending.alwaysAsk).toBe(true)
    expect(pending.taskContext).toContain('super-shell')

    // Answering "always" records nothing for it.
    act(() => {
      result.current.resolveApproval('tc-self', 'allow-always')
    })
    expect(useToolApproval.getState().approvedServers).toEqual([])
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

  it('a standing bash grant still asks before a destructive command, and says why', async () => {
    act(() => {
      useToolApproval.getState().approveToolForThread('thread-1', 'bash')
      useToolApproval.getState().approveToolEverywhere('bash')
    })
    const { result } = renderHook(() => useToolApprovalRequests())

    let ordinary: Promise<boolean>
    act(() => {
      ordinary = result.current.requestApproval(
        'tc-ok',
        'bash',
        'thread-1',
        undefined,
        {
          input: { command: 'npm test && rm -rf node_modules' },
          workspaceLabel: '/home/me/project',
        }
      )
      void result.current.requestApproval(
        'tc-rm',
        'bash',
        'thread-1',
        undefined,
        {
          input: { command: 'npm test && rm -rf ~' },
          workspaceLabel: '/home/me/project',
        }
      )
    })

    await expect(ordinary!).resolves.toBe(true)
    expect(result.current.pending['tc-ok']).toBeUndefined()
    expect(result.current.pending['tc-rm']).toBeDefined()
    expect(result.current.pending['tc-rm'].taskContext).toMatch(
      /Destructive command/
    )
  })

  it('judges absolute paths against the given workspace roots', async () => {
    act(() => {
      useToolApproval.getState().approveToolEverywhere('bash')
    })
    const { result } = renderHook(() => useToolApprovalRequests())
    const ask = (id: string, command: string, roots?: string[]) =>
      result.current.requestApproval(id, 'bash', 'thread-1', undefined, {
        input: { command },
        workspaceLabel: 'My project',
        ...(roots ? { workspaceRoots: roots } : {}),
      })

    let inside: Promise<boolean>
    act(() => {
      // Inside the second root: runs on the grant.
      inside = ask('tc-in', 'rm -rf "/data/ws one/build"', [
        '/p',
        '/data/ws one',
      ])
      // A sibling sharing the root's prefix, and unknown scope (a display
      // label is not a path): both still ask.
      void ask('tc-sib', 'rm -rf "/data/ws one-other"', ['/data/ws one'])
      void ask('tc-unknown', 'rm -rf "/data/ws one/build"')
    })
    await expect(inside!).resolves.toBe(true)
    expect(result.current.pending['tc-sib']).toBeDefined()
    expect(result.current.pending['tc-unknown']).toBeDefined()
  })

  it('leaves the destructive check to a caller that already ran it', async () => {
    act(() => {
      useToolApproval.getState().approveToolEverywhere('bash')
    })
    const { result } = renderHook(() => useToolApprovalRequests())
    let p: Promise<boolean>
    act(() => {
      p = result.current.requestApproval('tc1', 'bash', 'thread-1', undefined, {
        input: { command: 'rm -rf "/ws/build"' },
        destructiveChecked: true,
      })
    })
    await expect(p!).resolves.toBe(true)
  })

  it('pauses a streak of grant-approved calls at the configured limit', async () => {
    const { useAutoApproveLimit, resetAutoApproveStreak } = await import(
      '../useAutoApproveLimit'
    )
    useAutoApproveLimit.getState().setLimit(2)
    resetAutoApproveStreak('thread-1')
    act(() => {
      useToolApproval.getState().approveToolForThread('thread-1', 'tool-a')
    })
    const { result } = renderHook(() => useToolApprovalRequests())
    const ask = (id: string) =>
      result.current.requestApproval(id, 'tool-a', 'thread-1', undefined, {
        autoApproveStreak: 'thread-1',
      })

    let first: Promise<boolean>, second: Promise<boolean>
    act(() => {
      first = ask('c1')
      second = ask('c2')
      void ask('c3')
    })
    await expect(first!).resolves.toBe(true)
    await expect(second!).resolves.toBe(true)
    expect(result.current.pending['c3']?.taskContext).toBe(
      '2 tool calls ran without asking. Continue?'
    )
    // Being asked started the count over.
    let fourth: Promise<boolean>
    act(() => {
      fourth = ask('c4')
    })
    await expect(fourth!).resolves.toBe(true)
    // Without the key (Cowork counts on its own), nothing is counted here.
    let uncounted: Promise<boolean>
    act(() => {
      for (let i = 0; i < 5; i++) {
        uncounted = result.current.requestApproval(
          `u${i}`,
          'tool-a',
          'thread-1'
        )
      }
    })
    await expect(uncounted!).resolves.toBe(true)
    useAutoApproveLimit.getState().setLimit(50)
    resetAutoApproveStreak('thread-1')
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
    expect(
      useToolApproval.getState().isToolApproved('thread-1', 'tool-a')
    ).toBe(false)
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
      p = result.current.requestApproval(
        'tc1',
        'tool-a',
        'thread-1',
        'github',
        GH
      )
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
      approval.isToolApproved(
        'thread-2',
        'other-tool',
        'github',
        'sha256:changed'
      )
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
        p = result.current.requestApproval(
          'tc9',
          'tool-a',
          'thread-1',
          'github',
          GH
        )
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
      p = result.current.requestApproval(
        'tc1',
        'tool-a',
        'thread-1',
        'github',
        GH
      )
    })

    await expect(p!).resolves.toBe(true)
    expect(result.current.pending['tc1']).toBeUndefined()
  })

  it('keeps the server and its definition on the pending entry so the prompt can name it', async () => {
    const { result } = renderHook(() => useToolApprovalRequests())

    act(() => {
      void result.current.requestApproval(
        'tc1',
        'tool-a',
        'thread-1',
        'github',
        GH
      )
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
      ({
        serverFingerprints: vi.fn().mockResolvedValue({ github: 'sha256:gh' }),
      }) as never
    try {
      act(() => {
        void result.current.requestApproval(
          'tc1',
          'tool-a',
          'thread-1',
          'github'
        )
      })
      await vi.waitFor(() =>
        expect(useToolApprovalRequests.getState().pending['tc1']).toMatchObject(
          {
            serverName: 'github',
            serverFingerprint: 'sha256:gh',
          }
        )
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
    expect(
      useToolApproval.getState().isToolApproved('thread-1', 'tool-a')
    ).toBe(false)
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
    expect(result.current.pending['tcB']).toMatchObject({
      threadId: 'thread-B',
    })

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

    expect(result.current.pending['tcA']).toMatchObject({
      threadId: 'thread-A',
    })
  })
})
