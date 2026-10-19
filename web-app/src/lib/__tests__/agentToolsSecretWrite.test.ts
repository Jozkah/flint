import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkWriteSecrets = vi.fn()
const executeTool = vi.fn()
const previewChange = vi.fn()
const getJanDataFolder = vi.fn()

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  advertisedToolSchemas: vi.fn(),
  checkWriteSecrets: (...args: unknown[]) => checkWriteSecrets(...args),
  executeTool: (...args: unknown[]) => executeTool(...args),
  executeToolStreaming: vi.fn(),
  executeToolUnsandboxedRetry: vi.fn(),
  executeToolUnsandboxedWithdraw: vi.fn(),
  previewChange: (...args: unknown[]) => previewChange(...args),
  sandboxStatus: vi.fn().mockResolvedValue({ backend: 'bubblewrap', enforces: true }),
  sandboxToolchains: vi.fn(),
  threadWorkspaceDelete: vi.fn(),
  threadWorkspaceSweep: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (m: unknown) => void = () => {}
  },
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder }) }),
}))

const finding = {
  file: 'lib/env.ts',
  line: 2,
  rule: 'API key',
  snippet: 'export const k = "[redacted]"',
}
const input = { path: 'lib/env.ts', content: 'x' }

async function setup(mode: 'ask' | 'bypass' = 'ask') {
  const { useToolApproval } = await import('@/hooks/useToolApproval')
  const { useToolApprovalRequests } = await import(
    '@/hooks/useToolApprovalRequests'
  )
  useToolApproval.setState({ permissionMode: mode })
  const requestApproval = vi.fn()
  useToolApprovalRequests.setState({ requestApproval })
  return { requestApproval, useToolApprovalRequests }
}

beforeEach(() => {
  checkWriteSecrets.mockReset().mockResolvedValue([finding])
  executeTool.mockReset().mockResolvedValue({ content: 'wrote it', isError: false })
  previewChange.mockReset().mockResolvedValue('@@ diff @@')
  getJanDataFolder.mockReset().mockResolvedValue('/data')
})

/** The `approval` argument `executeTool` was last given. */
const approvalSent = () => executeTool.mock.calls.at(-1)?.[14]

describe('a write the credential scan would stop', () => {
  it('is put to the user as a card that is asked every time, with the finding', async () => {
    const { requestApproval } = await setup()
    requestApproval.mockResolvedValue(true)
    const { executeAgentTool } = await import('../agentTools')
    const result = await executeAgentTool('write', input, 't1', { callId: 'c1' })
    expect(requestApproval).toHaveBeenCalledTimes(1)
    const [callId, tool, thread, server, context] = requestApproval.mock.calls[0]
    expect([callId, tool, thread, server]).toEqual(['c1', 'write', 't1', undefined])
    expect(context.alwaysAsk).toBe(true)
    expect(context.secret).toEqual([finding])
    expect(context.preview).toBe('@@ diff @@')
    expect(context.taskContext).toContain('This write looks like it contains a secret')
    expect(context.taskContext).toContain('lib/env.ts:2')
    // "Write anyway" is the user's answer for this one write: the backend is told.
    expect(result.error).toBeUndefined()
    expect(approvalSent()).toBe('secret')
  })

  it('tells the model the user was asked, and why, when they deny', async () => {
    const { requestApproval, useToolApprovalRequests } = await setup()
    requestApproval.mockImplementation(async (callId: string) => {
      useToolApprovalRequests.setState({
        refusals: { [callId]: 'denied' },
        refusalReasons: { [callId]: 'it is the live key' },
      })
      return false
    })
    const { executeAgentTool } = await import('../agentTools')
    const result = await executeAgentTool('write', input, 't1', { callId: 'c2' })
    expect(executeTool).not.toHaveBeenCalled()
    expect(result.error).toContain('The user was asked')
    expect(result.error).toContain('denied it')
    expect(result.error).toContain('it is the live key')
    expect(result.error).toContain('lib/env.ts:2')
    expect(result.error).not.toContain('AKIA')
  })

  it('is auto-approved under Bypass, without a card, and recorded as Bypass', async () => {
    const { requestApproval } = await setup('bypass')
    const { executeAgentTool } = await import('../agentTools')
    const result = await executeAgentTool('write', input, 't1', { callId: 'c3' })
    expect(requestApproval).not.toHaveBeenCalled()
    expect(result.error).toBeUndefined()
    expect(approvalSent()).toBe('bypass')
  })

  it('is refused, with how to enable it, where nobody can answer', async () => {
    const { requestApproval } = await setup()
    const { executeAgentTool } = await import('../agentTools')
    const result = await executeAgentTool('write', input, 't1', {
      callId: 'c4',
      unattended: true,
    })
    expect(requestApproval).not.toHaveBeenCalled()
    expect(executeTool).not.toHaveBeenCalled()
    expect(result.error).toContain('nobody is here to ask')
    expect(result.error).toContain('Bypass permissions')
  })

  it('says the run was stopped when the card was withdrawn', async () => {
    const { requestApproval, useToolApprovalRequests } = await setup()
    requestApproval.mockImplementation(async (callId: string) => {
      useToolApprovalRequests.setState({ refusals: { [callId]: 'cancelled' } })
      return false
    })
    const { executeAgentTool } = await import('../agentTools')
    const result = await executeAgentTool('write', input, 't1', { callId: 'c5' })
    expect(result.error).toContain('run was stopped')
    expect(result.error).not.toContain('denied')
  })

  it('asks nothing when nothing is flagged, and for other tools', async () => {
    const { requestApproval } = await setup()
    const { executeAgentTool } = await import('../agentTools')
    checkWriteSecrets.mockResolvedValue([])
    await executeAgentTool('write', input, 't1', { callId: 'c6' })
    await executeAgentTool('read', { path: 'a.ts' }, 't1', { callId: 'c7' })
    expect(requestApproval).not.toHaveBeenCalled()
    expect(checkWriteSecrets).toHaveBeenCalledTimes(1)
    expect(['secret', 'bypass']).not.toContain(approvalSent())
  })

  it('never asks the user about their own saved edit', async () => {
    const { requestApproval } = await setup()
    const { executeAgentTool } = await import('../agentTools')
    await executeAgentTool('write', input, 't1', {
      actor: { id: 'user', label: 'You' },
    })
    expect(requestApproval).not.toHaveBeenCalled()
    expect(checkWriteSecrets).not.toHaveBeenCalled()
  })

  it('lets the backend refuse when the check itself cannot run', async () => {
    const { requestApproval } = await setup()
    checkWriteSecrets.mockRejectedValue(new Error('no workspace'))
    const { executeAgentTool } = await import('../agentTools')
    await executeAgentTool('write', input, 't1', { callId: 'c8' })
    expect(requestApproval).not.toHaveBeenCalled()
    expect(executeTool).toHaveBeenCalledTimes(1)
  })
})
