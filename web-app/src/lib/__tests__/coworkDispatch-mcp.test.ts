import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  executeAgentTool: vi.fn(),
  callTool: vi.fn(),
  allowOnceForServer: vi.fn(),
  disabled: [] as string[],
}))
vi.mock('@/lib/agentTools', () => ({
  executeAgentTool: h.executeAgentTool,
  previewAgentChange: vi.fn(),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    mcp: () => ({
      callTool: h.callTool,
      allowOnceForServer: h.allowOnceForServer,
    }),
  }),
}))
vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: {
    getState: () => ({
      isToolDisabled: (s: string, t: string) => h.disabled.includes(`${s}::${t}`),
    }),
  },
}))

import { dispatchCoworkTool } from '../coworkDispatch'
import type { CoworkMode } from '../coworkMode'

const call = { toolCallId: 'c1', toolName: 'ida_decompile', input: { addr: 1 } }

const ctx = (over = {}) => ({
  sessionId: 's1',
  readOnlyFolder: null,
  mode: 'auto' as CoworkMode,
  webSearch: false,
  onTodo: vi.fn(),
  onAsk: vi.fn(),
  onTask: vi.fn(),
  mcpServerFor: (name: string) =>
    name === 'ida_decompile' ? 'ida-multi-mcp' : undefined,
  ...over,
})

describe('an MCP tool called from Cowork', () => {
  beforeEach(() => {
    h.executeAgentTool.mockReset()
    h.callTool.mockReset()
    h.allowOnceForServer.mockReset()
    h.allowOnceForServer.mockResolvedValue('ticket-1')
    h.callTool.mockResolvedValue({ error: '', content: [{ text: 'int main()' }] })
    h.disabled = []
  })

  it('asks first, naming the server, then calls it with the ticket the approval minted', async () => {
    const onApproveMcp = vi.fn(async () => true)
    const out = await dispatchCoworkTool(call, ctx({ onApproveMcp }))
    expect(onApproveMcp).toHaveBeenCalledWith(
      'c1',
      'ida_decompile',
      { addr: 1 },
      'ida-multi-mcp',
      undefined
    )
    expect(h.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'ida_decompile',
        serverName: 'ida-multi-mcp',
        approvalTicket: 'ticket-1',
        arguments: { addr: 1 },
      })
    )
    expect(out).toEqual({ output: 'int main()' })
    expect(h.executeAgentTool).not.toHaveBeenCalled()
  })

  it('does not call the server when the user says no', async () => {
    const out = await dispatchCoworkTool(
      call,
      ctx({ onApproveMcp: vi.fn(async () => false) })
    )
    expect(h.callTool).not.toHaveBeenCalled()
    expect(out.isError).toBe(true)
    expect(out.output).toMatch(/did not allow/)
  })

  it('is asked in auto mode too: a tool that appeared mid-chat is never auto-approved', async () => {
    const onApproveMcp = vi.fn(async () => false)
    await dispatchCoworkTool(call, ctx({ mode: 'auto', onApproveMcp }))
    expect(onApproveMcp).toHaveBeenCalledTimes(1)
  })

  it('refuses when nothing can present the prompt', async () => {
    const out = await dispatchCoworkTool(call, ctx())
    expect(h.callTool).not.toHaveBeenCalled()
    expect(out.isError).toBe(true)
  })

  it('refuses in review mode without asking', async () => {
    const onApproveMcp = vi.fn(async () => true)
    const out = await dispatchCoworkTool(
      call,
      ctx({ mode: 'review' as CoworkMode, onApproveMcp })
    )
    expect(onApproveMcp).not.toHaveBeenCalled()
    expect(h.callTool).not.toHaveBeenCalled()
    expect(out.isError).toBe(true)
  })

  it('refuses a tool the user disabled even if the model repeats an old call', async () => {
    h.disabled = ['ida-multi-mcp::ida_decompile']
    const onApproveMcp = vi.fn(async () => true)
    const out = await dispatchCoworkTool(call, ctx({ onApproveMcp }))
    expect(onApproveMcp).not.toHaveBeenCalled()
    expect(h.callTool).not.toHaveBeenCalled()
    expect(out.output).toMatch(/disabled/)
  })

  it('reports a server failure to the model as an error', async () => {
    h.callTool.mockResolvedValue({ error: 'boom', content: [] })
    const out = await dispatchCoworkTool(
      call,
      ctx({ onApproveMcp: vi.fn(async () => true) })
    )
    expect(out).toEqual({ output: 'boom', isError: true })
  })

  it('leaves built-in tools alone', async () => {
    h.executeAgentTool.mockResolvedValue({ content: 'file' })
    await dispatchCoworkTool(
      { toolCallId: 'c2', toolName: 'read', input: { path: 'a' } },
      ctx()
    )
    expect(h.executeAgentTool).toHaveBeenCalled()
    expect(h.callTool).not.toHaveBeenCalled()
  })
})
