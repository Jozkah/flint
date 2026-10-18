import { describe, it, expect, vi, beforeEach } from 'vitest'

const { executeAgentTool } = vi.hoisted(() => ({ executeAgentTool: vi.fn() }))
const { previewAgentChange } = vi.hoisted(() => ({
  previewAgentChange: vi.fn(async (): Promise<string | undefined> => undefined),
}))
vi.mock('@/lib/agentTools', () => ({ executeAgentTool, previewAgentChange }))
vi.mock('@/lib/webSearchTool', () => ({
  WEB_TOOL_NAMES: new Set(['web_search', 'web_fetch']),
  executeWebTool: vi.fn(),
}))
const { checkScopedRule } = vi.hoisted(() => ({ checkScopedRule: vi.fn() }))
vi.mock('@/lib/approvalScopes', async (orig) => ({
  ...(await orig<typeof import('@/lib/approvalScopes')>()),
  checkScopedRule,
}))

import { dispatchCoworkTool } from '../coworkDispatch'
import type { PendingToolCall } from '../coworkRunner'
import type { CoworkMode } from '../coworkMode'

const call = (toolName: string, input: unknown = {}): PendingToolCall => ({
  toolCallId: 'c1',
  toolName,
  input,
})

const TREE = 'C:/work/tree'
const RULE = { id: 'rule-7', tool: 'write', kind: 'write' }

const ctx = (over = {}) => ({
  sessionId: 's1',
  readOnlyFolder: null,
  worktreePath: TREE,
  mode: 'ask' as CoworkMode,
  webSearch: false,
  onTodo: vi.fn(async () => ({ output: 'todo ok' })),
  onAsk: vi.fn(async () => ({ output: 'ask ok' })),
  onTask: vi.fn(async () => ({ output: 'task ok' })),
  ...over,
})

describe('a saved approval rule in front of the prompt', () => {
  beforeEach(() => {
    executeAgentTool.mockReset()
    executeAgentTool.mockResolvedValue({ content: 'ok' })
    checkScopedRule.mockReset()
    checkScopedRule.mockResolvedValue(null)
  })

  it('runs a covered call without asking', async () => {
    checkScopedRule.mockResolvedValue(RULE)
    const onApprove = vi.fn(async () => false)
    const out = await dispatchCoworkTool(
      call('write', { path: 'src/a.ts', content: 'x' }),
      ctx({ onApprove })
    )
    expect(onApprove).not.toHaveBeenCalled()
    expect(out.isError).toBeUndefined()
    expect(executeAgentTool).toHaveBeenCalled()
    expect(checkScopedRule).toHaveBeenCalledWith(TREE, 'write', {
      path: 'src/a.ts',
      content: 'x',
    })
  })

  it('asks as before when no rule covers the call', async () => {
    const onApprove = vi.fn(async () => true)
    await dispatchCoworkTool(
      call('write', { path: 'src/a.ts', content: 'x' }),
      ctx({ onApprove })
    )
    expect(onApprove).toHaveBeenCalled()
  })

  it('keeps a refusal a refusal when no rule covers the call', async () => {
    checkScopedRule.mockResolvedValue(null)
    const out = await dispatchCoworkTool(
      call('write', { path: 'src/a.ts', content: 'x' }),
      ctx({ onApprove: vi.fn(async () => false) })
    )
    expect(out.isError).toBe(true)
    expect(executeAgentTool).not.toHaveBeenCalled()
  })

  it('never consults a rule for a destructive command, which is asked every time', async () => {
    checkScopedRule.mockResolvedValue({ id: 'rule-8', tool: 'bash', kind: 'exec' })
    const onApprove = vi.fn(async () => false)
    const out = await dispatchCoworkTool(
      call('bash', { command: 'rm -rf /' }),
      ctx({ onApprove })
    )
    expect(checkScopedRule).not.toHaveBeenCalled()
    expect(onApprove).toHaveBeenCalled()
    expect(out.isError).toBe(true)
    expect(executeAgentTool).not.toHaveBeenCalled()
  })

  it('never consults a rule for a push', async () => {
    checkScopedRule.mockResolvedValue({ id: 'rule-9', tool: 'git', kind: 'write' })
    const onApprove = vi.fn(async () => false)
    await dispatchCoworkTool(
      call('git', { args: ['push', 'origin', 'main'] }),
      ctx({ onApprove })
    )
    expect(checkScopedRule).not.toHaveBeenCalled()
  })

  it('only asks about the tools the form covers', async () => {
    const onApprove = vi.fn(async () => true)
    await dispatchCoworkTool(call('read', { path: 'a' }), ctx({ onApprove }))
    expect(checkScopedRule).not.toHaveBeenCalled()
  })

  it('has nothing to ask a rule about without a folder', async () => {
    const onApprove = vi.fn(async () => true)
    await dispatchCoworkTool(
      call('write', { path: 'a', content: 'x' }),
      ctx({ onApprove, worktreePath: undefined })
    )
    expect(checkScopedRule).not.toHaveBeenCalled()
    expect(onApprove).toHaveBeenCalled()
  })

  it('does not consult a rule in review mode, where mutations are refused outright', async () => {
    checkScopedRule.mockResolvedValue(RULE)
    const out = await dispatchCoworkTool(
      call('write', { path: 'a', content: 'x' }),
      ctx({ mode: 'review' })
    )
    expect(out.isError).toBe(true)
    expect(executeAgentTool).not.toHaveBeenCalled()
    expect(checkScopedRule).not.toHaveBeenCalled()
  })
})
