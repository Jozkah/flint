import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  migrateToolApproval,
  TOOL_APPROVAL_STORE_VERSION,
  useToolApproval,
} from '../useToolApproval'
import { useToolApprovalRequests } from '../useToolApprovalRequests'
import { getServiceHub } from '@/hooks/useServiceHub'

// Mock-backed: persistence is stubbed and the backend MCP service is a fake
// whose fingerprints stand in for what `mcp_server_fingerprints` would report.
// This checks the renderer's lifecycle rules, not a Tauri round trip.
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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const NOTES_NPX = 'sha256:notes-npx'
const NOTES_EVIL = 'sha256:notes-evil-binary'
const REMOTE_A = 'sha256:remote-mcp.example.com'
const REMOTE_B = 'sha256:remote-attacker.test'

/** A fake backend whose server fingerprints the test can change. */
function fakeMcp(initial: Record<string, string>) {
  let fingerprints = { ...initial }
  const mcp = {
    serverFingerprints: vi.fn(async () => ({ ...fingerprints })),
    trustServer: vi.fn().mockResolvedValue(undefined),
    revokeServer: vi.fn().mockResolvedValue(undefined),
    forgetServer: vi.fn().mockResolvedValue(undefined),
  }
  return {
    mcp,
    set: (next: Record<string, string>) => {
      fingerprints = { ...next }
    },
  }
}

async function withMcp(mcp: Record<string, unknown>, run: () => Promise<void>) {
  const hub = getServiceHub() as unknown as Record<string, unknown>
  const real = hub.mcp
  hub.mcp = () => mcp as never
  try {
    await run()
  } finally {
    hub.mcp = real
  }
}

/** Ask for a call and report whether it was answered without a prompt. */
async function answeredWithoutPrompt(
  id: string,
  tool: string,
  thread: string,
  server?: string
): Promise<boolean> {
  let settled = false
  const result = useToolApprovalRequests
    .getState()
    .requestApproval(id, tool, thread, server)
    .then((ok) => {
      settled = true
      return ok
    })
  // Let the fingerprint lookup resolve.
  for (let i = 0; i < 5; i++) await Promise.resolve()
  if (settled) return result
  // Still pending: a prompt is showing. Deny it so nothing leaks between tests.
  useToolApprovalRequests.getState().resolveApproval(id, 'deny')
  await result
  return false
}

async function approve(
  id: string,
  tool: string,
  thread: string,
  server: string,
  decision: 'allow-thread' | 'allow-always'
) {
  const pending = useToolApprovalRequests
    .getState()
    .requestApproval(id, tool, thread, server)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  useToolApprovalRequests.getState().resolveApproval(id, decision)
  return pending
}

beforeEach(() => {
  useToolApprovalRequests.setState({
    pending: {},
    refusals: {},
    approvedFingerprints: {},
  })
  useToolApproval.setState({
    approvedTools: {},
    approvedMcpTools: {},
    approvedServers: [],
    approvedToolsGlobal: [],
    approvedSimilarCalls: [],
    invalidatedServers: [],
    allowAllMCPPermissions: false,
  })
})

describe('store migration', () => {
  const AT = () => '2026-09-13T00:00:00.000Z'

  it('is versioned', () => {
    expect(TOOL_APPROVAL_STORE_VERSION).toBe(3)
  })

  it('drops name-only server approvals and lists them as needing renewal', () => {
    const migrated = migrateToolApproval(
      {
        approvedServers: ['github', 'notes'],
        approvedTools: { 'thread-1': ['bash', 'create_issue'] },
        approvedToolsGlobal: ['web_fetch'],
        allowAllMCPPermissions: false,
      },
      0,
      AT
    )
    expect(migrated.approvedServers).toEqual([])
    expect(migrated.invalidatedServers).toEqual([
      { name: 'github', reason: 'legacy-approval', at: AT() },
      { name: 'notes', reason: 'legacy-approval', at: AT() },
    ])
    expect(migrated.approvedMcpTools).toEqual({})
  })

  it('keeps built-in tool grants working, but name-only grants no longer cover a server tool', () => {
    const migrated = migrateToolApproval(
      {
        approvedServers: [],
        approvedTools: { 'thread-1': ['bash', 'create_issue'] },
        approvedToolsGlobal: ['web_fetch'],
      },
      0,
      AT
    )
    useToolApproval.setState(migrated)
    const store = useToolApproval.getState()
    expect(store.isToolApproved('thread-1', 'bash')).toBe(true)
    expect(store.isToolApproved('thread-9', 'web_fetch')).toBe(true)
    // `create_issue` was really an MCP grant: it answers for no server now.
    expect(store.isToolApproved('thread-1', 'create_issue', 'github', 'sha256:x')).toBe(
      false
    )
  })

  it('keeps an already-bound shape and discards malformed entries', () => {
    const migrated = migrateToolApproval(
      {
        approvedServers: [
          { name: 'github', fingerprint: 'sha256:gh' },
          { name: 'broken' },
          42,
        ],
        approvedMcpTools: {
          't1': [
            { server: 'github', tool: 'create_issue', fingerprint: 'sha256:gh' },
            { server: 'github', tool: 'no-fingerprint' },
          ],
        },
        invalidatedServers: [
          { name: 'old', reason: 'configuration-changed', at: 'x' },
          { name: 'bad', reason: 'nonsense', at: 'x' },
        ],
        allowAllMCPPermissions: true,
      },
      1,
      AT
    )
    expect(migrated.approvedServers).toEqual([
      { name: 'github', fingerprint: 'sha256:gh' },
    ])
    expect(migrated.approvedMcpTools).toEqual({
      t1: [{ server: 'github', tool: 'create_issue', fingerprint: 'sha256:gh' }],
    })
    expect(migrated.invalidatedServers).toEqual([
      { name: 'old', reason: 'configuration-changed', at: 'x' },
    ])
    expect(migrated.allowAllMCPPermissions).toBe(true)
  })

  it('survives garbage', () => {
    expect(migrateToolApproval(null, 0, AT)).toEqual({
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

  it('restores only recognized similar-call grants', () => {
    const restored = migrateToolApproval({
      approvedSimilarCalls: [
        { key: 'host_powershell:stop-process-id', label: 'PowerShell: Stop-Process -Id' },
        { key: 'host_powershell:any-script', label: 'Any script' },
      ],
    }, 3, AT)
    expect(restored.approvedSimilarCalls).toEqual([
      { key: 'host_powershell:stop-process-id', label: 'PowerShell: Stop-Process -Id' },
    ])
  })
})

describe('MCP permission lifecycle', () => {
  it('an always-allow is bound to the server definition the user approved', async () => {
    const backend = fakeMcp({ notes: NOTES_NPX })
    await withMcp(backend.mcp, async () => {
      await expect(approve('a', 'read', 't1', 'notes', 'allow-always')).resolves.toBe(true)
      expect(backend.mcp.trustServer).toHaveBeenCalledWith('notes', NOTES_NPX)
      expect(useToolApproval.getState().approvedServers).toEqual([
        { name: 'notes', fingerprint: NOTES_NPX },
      ])
      expect(await answeredWithoutPrompt('b', 'write', 't2', 'notes')).toBe(true)
      // And the call is handed over bound to the same definition.
      expect(useToolApprovalRequests.getState().takeApprovedFingerprint('b')).toBe(
        NOTES_NPX
      )
    })
  })

  it('a changed executable invalidates the approval and says why', async () => {
    const backend = fakeMcp({ notes: NOTES_NPX })
    await withMcp(backend.mcp, async () => {
      await approve('a', 'read', 't1', 'notes', 'allow-always')
      backend.set({ notes: NOTES_EVIL })
      expect(await answeredWithoutPrompt('b', 'read', 't1', 'notes')).toBe(false)
      const store = useToolApproval.getState()
      expect(store.approvedServers).toEqual([])
      expect(store.invalidatedServers).toMatchObject([
        { name: 'notes', reason: 'configuration-changed' },
      ])
      // Changing it back does not silently restore the approval.
      backend.set({ notes: NOTES_NPX })
      expect(await answeredWithoutPrompt('c', 'read', 't1', 'notes')).toBe(false)
    })
  })

  it('a changed endpoint invalidates a conversation grant too', async () => {
    const backend = fakeMcp({ remote: REMOTE_A })
    await withMcp(backend.mcp, async () => {
      await approve('a', 'search', 't1', 'remote', 'allow-thread')
      expect(useToolApproval.getState().approvedMcpTools).toEqual({
        t1: [{ server: 'remote', tool: 'search', fingerprint: REMOTE_A }],
      })
      expect(await answeredWithoutPrompt('b', 'search', 't1', 'remote')).toBe(true)

      backend.set({ remote: REMOTE_B })
      expect(await answeredWithoutPrompt('c', 'search', 't1', 'remote')).toBe(false)
      expect(useToolApproval.getState().approvedMcpTools).toEqual({})
      expect(useToolApproval.getState().invalidatedServers).toMatchObject([
        { name: 'remote', reason: 'configuration-changed' },
      ])
    })
  })

  it('deleting a server removes its grants, and a new server with the same name has none', async () => {
    const backend = fakeMcp({ notes: NOTES_NPX })
    await withMcp(backend.mcp, async () => {
      await approve('a', 'read', 't1', 'notes', 'allow-always')
      await approve('b', 'write', 't1', 'notes', 'allow-thread')

      await useToolApproval.getState().forgetServer('notes', 'deleted')
      expect(backend.mcp.forgetServer).toHaveBeenCalledWith('notes', 'deleted')
      const store = useToolApproval.getState()
      expect(store.approvedServers).toEqual([])
      expect(store.approvedMcpTools).toEqual({})

      // Re-added under the same name -- even with an identical definition.
      expect(await answeredWithoutPrompt('c', 'read', 't1', 'notes')).toBe(false)
      expect(await answeredWithoutPrompt('d', 'write', 't1', 'notes')).toBe(false)
    })
  })

  it('renaming a server requires renewed approval under the new name', async () => {
    const backend = fakeMcp({ notes: NOTES_NPX })
    await withMcp(backend.mcp, async () => {
      await approve('a', 'read', 't1', 'notes', 'allow-always')

      // The definition is unchanged, so the fingerprint is the same; only the
      // name moved.
      backend.set({ 'notes-renamed': NOTES_NPX })
      await useToolApproval.getState().forgetServer('notes', 'renamed')
      expect(backend.mcp.forgetServer).toHaveBeenCalledWith('notes', 'renamed')
      expect(await answeredWithoutPrompt('b', 'read', 't1', 'notes-renamed')).toBe(false)
    })
  })

  it('revoking a server withdraws the renderer grant after the backend agrees', async () => {
    const backend = fakeMcp({ notes: NOTES_NPX })
    await withMcp(backend.mcp, async () => {
      await approve('a', 'read', 't1', 'notes', 'allow-always')
      await useToolApproval.getState().revokeServerTrust('notes')
      expect(backend.mcp.revokeServer).toHaveBeenCalledWith('notes')
      expect(await answeredWithoutPrompt('b', 'read', 't1', 'notes')).toBe(false)
    })
  })

  it('an unknown server definition matches no grant and records none', async () => {
    const backend = fakeMcp({})
    await withMcp(backend.mcp, async () => {
      useToolApproval.getState().approveServer('ghost', 'sha256:old')
      await expect(approve('a', 'read', 't1', 'ghost', 'allow-thread')).resolves.toBe(true)
      expect(useToolApproval.getState().approvedMcpTools).toEqual({})
      expect(useToolApprovalRequests.getState().takeApprovedFingerprint('a')).toBeUndefined()
    })
  })

  it('withdraws the renderer grant when the backend refuses to trust the server', async () => {
    const backend = fakeMcp({ notes: NOTES_NPX })
    backend.mcp.trustServer.mockRejectedValue(new Error('configuration changed'))
    await withMcp(backend.mcp, async () => {
      await approve('a', 'read', 't1', 'notes', 'allow-always')
      await vi.waitFor(() =>
        expect(useToolApproval.getState().approvedServers).toEqual([])
      )
    })
  })

  it('keeps grants for a server that is only turned off', async () => {
    const backend = fakeMcp({ notes: NOTES_NPX })
    await withMcp(backend.mcp, async () => {
      await approve('a', 'read', 't1', 'notes', 'allow-always')
      // Turning a server off does not change its definition (`active` is not
      // part of the fingerprint), and nothing here forgets it.
      expect(await answeredWithoutPrompt('b', 'read', 't1', 'notes')).toBe(true)
      expect(backend.mcp.forgetServer).not.toHaveBeenCalled()
    })
  })
})
