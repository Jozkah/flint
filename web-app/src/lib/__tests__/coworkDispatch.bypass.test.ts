import { describe, it, expect, vi, beforeEach } from 'vitest'

const { executeAgentTool } = vi.hoisted(() => ({ executeAgentTool: vi.fn() }))
vi.mock('@/lib/agentTools', () => ({
  executeAgentTool,
  previewAgentChange: vi.fn(async () => undefined),
}))

import { dispatchCoworkTool, effectiveMode } from '../coworkDispatch'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useToolApproval } from '@/hooks/useToolApproval'
import type { CoworkMode } from '../coworkMode'

const ctx = (
  mode: CoworkMode,
  extra: Record<string, unknown> = {},
  onApprove = vi.fn(async () => true)
) => ({
  sessionId: 's1',
  readOnlyFolder: 'C:/proj',
  mode,
  webSearch: false,
  onTodo: vi.fn(async () => ({ output: 'todo ok' })),
  onAsk: vi.fn(async () => ({ output: 'ask ok' })),
  onTask: vi.fn(async () => ({ output: 'task ok' })),
  onApprove,
  ...extra,
})

const powershell = {
  toolCallId: 'p1',
  toolName: 'host_powershell',
  input: { script: 'python -c "print(1)"' },
}

beforeEach(() => {
  executeAgentTool.mockReset()
  executeAgentTool.mockResolvedValue({ content: 'ok' })
  useToolApproval.setState({ permissionMode: 'ask' })
})

describe('Bypass means no prompt for host tools', () => {
  it('runs host_powershell with the bypass approval source and asks nobody', async () => {
    const c = ctx('bypass')
    const out = await dispatchCoworkTool(powershell, c)
    expect(out.isError).toBeFalsy()
    expect(c.onApprove).not.toHaveBeenCalled()
    expect(executeAgentTool.mock.calls[0][3]).toMatchObject({
      approvalSource: 'bypass',
    })
  })

  it('applies a switch to Bypass made after the run started', async () => {
    const c = ctx('ask', { liveMode: () => 'bypass' as CoworkMode })
    await dispatchCoworkTool(powershell, c)
    expect(c.onApprove).not.toHaveBeenCalled()
    expect(executeAgentTool.mock.calls[0][3]).toMatchObject({
      approvalSource: 'bypass',
    })
  })

  it('stops bypassing once the person switches away from Bypass', async () => {
    const c = ctx('bypass', { liveMode: () => 'ask' as CoworkMode })
    await dispatchCoworkTool(powershell, c)
    expect(executeAgentTool.mock.calls[0][3].approvalSource).toBeUndefined()
  })

  it('treats the app-wide Bypass as Bypass here too', async () => {
    useToolApproval.setState({ permissionMode: 'bypass' })
    expect(effectiveMode(ctx('ask'))).toBe('bypass')
  })

  it('lets a subagent context follow the live mode the same way', () => {
    const child = ctx('ask', { liveMode: () => 'bypass' as CoworkMode })
    expect(effectiveMode(child)).toBe('bypass')
  })
})

describe('what Bypass still refuses, and why', () => {
  it('keeps a run that started in Review read-only, whatever the session says now', async () => {
    const c = ctx('review', { liveMode: () => 'bypass' as CoworkMode })
    expect(effectiveMode(c)).toBe('review')
    const out = await dispatchCoworkTool(
      { toolCallId: 'w1', toolName: 'write', input: { path: 'a.txt', content: 'x' } },
      c
    )
    expect(out.isError).toBe(true)
    expect(out.output).toContain('review mode')
    expect(executeAgentTool).not.toHaveBeenCalled()
  })

  it('says Bypass cannot override a deny rule', async () => {
    executeAgentTool.mockResolvedValue({
      error: "ERROR [permission_denied]: tool 'bash' denied by project policy",
    })
    const out = await dispatchCoworkTool(
      { toolCallId: 'b1', toolName: 'bash', input: { command: 'ls' } },
      ctx('bypass')
    )
    expect(out.isError).toBe(true)
    expect(out.output).toContain('denied by project policy')
    expect(out.output).toContain('Bypass skips approval prompts only')
  })

  it('does not add the sentence to an ordinary failure', async () => {
    executeAgentTool.mockResolvedValue({ error: 'file not found' })
    const out = await dispatchCoworkTool(
      { toolCallId: 'b2', toolName: 'bash', input: { command: 'ls' } },
      ctx('bypass')
    )
    expect(out.output).toBe('file not found')
  })
})

describe('allowPendingForThread', () => {
  it('allows what a thread is waiting on and leaves other threads alone', async () => {
    const store = useToolApprovalRequests.getState()
    const mine = store.requestApproval('c1', 'host_powershell', 'sA', undefined, {
      input: {},
    })
    const theirs = store.requestApproval('c2', 'host_powershell', 'sB', undefined, {
      input: {},
    })
    useToolApprovalRequests.getState().allowPendingForThread('sA')
    await expect(mine).resolves.toBe(true)
    expect(useToolApprovalRequests.getState().pending['c2']).toBeDefined()
    useToolApprovalRequests.getState().resolveApproval('c2', 'deny')
    await expect(theirs).resolves.toBe(false)
  })
})
