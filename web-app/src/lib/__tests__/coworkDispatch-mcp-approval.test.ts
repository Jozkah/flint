import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The MCP approval path of Cowork end to end: the real dispatcher, the real
 * approval queue and the real grant store. Only the backend is faked.
 *
 * What it pins: no call reaches the server, and no backend ticket is minted,
 * before the user answers, unless a grant the user made for this server's
 * current definition (or "allow every MCP tool") covers it.
 */
const h = vi.hoisted(() => ({
  callTool: vi.fn(),
  allowOnceForServer: vi.fn(),
  trustServer: vi.fn(),
  fingerprint: 'fp-1',
}))
vi.mock('@/lib/agentTools', () => ({
  executeAgentTool: vi.fn(),
  previewAgentChange: vi.fn(),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    mcp: () => ({
      callTool: h.callTool,
      allowOnceForServer: h.allowOnceForServer,
      trustServer: h.trustServer,
      serverFingerprints: async () => ({ ida: h.fingerprint }),
    }),
  }),
}))
vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
}))

import { dispatchCoworkTool } from '../coworkDispatch'
import type { CoworkMode } from '../coworkMode'
import { useToolApproval } from '@/hooks/useToolApproval'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import {
  resetAutoApproveStreak,
  useAutoApproveLimit,
} from '@/hooks/useAutoApproveLimit'

const SESSION = 's1'
const call = (id: string) => ({
  toolCallId: id,
  toolName: 'ida_decompile',
  input: { addr: 1 },
})

const run = (id: string, mode: CoworkMode) =>
  dispatchCoworkTool(call(id), {
    sessionId: SESSION,
    readOnlyFolder: null,
    mode,
    webSearch: false,
    onTodo: vi.fn(),
    onAsk: vi.fn(),
    onTask: vi.fn(),
    mcpServerFor: (name: string) => (name === 'ida_decompile' ? 'ida' : undefined),
    // The same wiring as the Cowork route.
    onApproveMcp: (callId, toolName, input, server, signal) =>
      useToolApprovalRequests
        .getState()
        .requestApproval(callId, toolName, SESSION, server, {
          input,
          autoApproveStreak: SESSION,
          signal,
        }),
  } as never)

/** Lets the approval queue register the prompt. */
const settle = () => new Promise((r) => setTimeout(r, 0))

const pendingFor = (id: string) =>
  useToolApprovalRequests.getState().pending[id]

beforeEach(() => {
  h.callTool.mockReset()
  h.allowOnceForServer.mockReset()
  h.trustServer.mockReset()
  h.fingerprint = 'fp-1'
  h.allowOnceForServer.mockResolvedValue('ticket-1')
  h.trustServer.mockResolvedValue(undefined)
  h.callTool.mockResolvedValue({ error: '', content: [{ text: 'ok' }] })
  useToolApproval.setState({
    approvedTools: {},
    approvedMcpTools: {},
    approvedServers: [],
    approvedToolsGlobal: [],
    invalidatedServers: [],
    allowAllMCPPermissions: false,
  })
  useToolApprovalRequests.setState({
    pending: {},
    queued: {},
    refusals: {},
    approvedFingerprints: {},
    answeredByPrompt: {},
    allowedOnceCommands: {},
    temporaryGitThreads: {},
  })
  useAutoApproveLimit.setState({ limit: 3 })
  resetAutoApproveStreak(SESSION)
})

describe.each(['ask', 'auto'] as const)(
  'a server turned on mid-session, %s mode, nothing granted',
  (mode) => {
    it('shows the prompt and runs nothing before the click', async () => {
      const outcome = run('c1', mode)
      await settle()
      expect(pendingFor('c1')?.serverName).toBe('ida')
      expect(h.allowOnceForServer).not.toHaveBeenCalled()
      expect(h.callTool).not.toHaveBeenCalled()

      useToolApprovalRequests.getState().resolveApproval('c1', 'allow-once')
      expect(await outcome).toEqual({ output: 'ok' })
      expect(h.allowOnceForServer).toHaveBeenCalledTimes(1)
      expect(h.allowOnceForServer).toHaveBeenCalledWith('ida', 'ida_decompile', 'fp-1')
      expect(h.callTool).toHaveBeenCalledWith(
        expect.objectContaining({ approvalTicket: 'ticket-1', serverName: 'ida' })
      )
    })

    it('mints no ticket and calls nothing when the user denies', async () => {
      const outcome = run('c1', mode)
      await settle()
      useToolApprovalRequests.getState().resolveApproval('c1', 'deny')
      expect((await outcome).isError).toBe(true)
      expect(h.allowOnceForServer).not.toHaveBeenCalled()
      expect(h.callTool).not.toHaveBeenCalled()
    })

    it('does not reuse one answer for the next call', async () => {
      const first = run('c1', mode)
      await settle()
      useToolApprovalRequests.getState().resolveApproval('c1', 'allow-once')
      await first
      const second = run('c2', mode)
      await settle()
      expect(pendingFor('c2')).toBeDefined()
      expect(h.callTool).toHaveBeenCalledTimes(1)
      useToolApprovalRequests.getState().resolveApproval('c2', 'deny')
      await second
    })

    it('prompts when the grant was made for another definition of the server', async () => {
      useToolApproval.setState({
        approvedServers: [{ name: 'ida', fingerprint: 'fp-OLD' }],
      })
      const outcome = run('c1', mode)
      await settle()
      expect(pendingFor('c1')).toBeDefined()
      expect(h.callTool).not.toHaveBeenCalled()
      useToolApprovalRequests.getState().resolveApproval('c1', 'deny')
      await outcome
    })

    it('prompts when only a grant for another conversation exists', async () => {
      useToolApproval.setState({
        approvedMcpTools: {
          'other-thread': [{ server: 'ida', tool: 'ida_decompile', fingerprint: 'fp-1' }],
        },
      })
      const outcome = run('c1', mode)
      await settle()
      expect(pendingFor('c1')).toBeDefined()
      useToolApprovalRequests.getState().resolveApproval('c1', 'deny')
      await outcome
    })
  }
)

describe('a server the user already trusted for its current definition', () => {
  beforeEach(() => {
    useToolApproval.setState({
      approvedServers: [{ name: 'ida', fingerprint: 'fp-1' }],
    })
  })

  it('runs without a prompt, as it does in chat', async () => {
    const outcome = await run('c1', 'auto')
    expect(outcome).toEqual({ output: 'ok' })
    expect(useToolApprovalRequests.getState().pending).toEqual({})
  })

  it('still pauses for the user after the consecutive-unasked limit', async () => {
    for (let i = 1; i <= 3; i++) {
      expect(await run(`c${i}`, 'auto')).toEqual({ output: 'ok' })
    }
    const fourth = run('c4', 'auto')
    await settle()
    expect(pendingFor('c4')).toBeDefined()
    expect(h.callTool).toHaveBeenCalledTimes(3)
    useToolApprovalRequests.getState().resolveApproval('c4', 'deny')
    await fourth
  })
})
