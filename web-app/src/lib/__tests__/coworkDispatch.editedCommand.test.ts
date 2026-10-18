import { describe, it, expect, vi, beforeEach } from 'vitest'

const { executeAgentTool } = vi.hoisted(() => ({ executeAgentTool: vi.fn() }))
const { previewAgentChange } = vi.hoisted(() => ({
  previewAgentChange: vi.fn(async (): Promise<string | undefined> => undefined),
}))
vi.mock('@/lib/agentTools', () => ({ executeAgentTool, previewAgentChange }))

import { dispatchCoworkTool } from '../coworkDispatch'
import { assistantMessageFor, turnsFor } from '../coworkRunner'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import type { CoworkMode } from '../coworkMode'

const ctx = (onApprove: () => Promise<boolean>) => ({
  sessionId: 's1',
  readOnlyFolder: null,
  mode: 'ask' as CoworkMode,
  webSearch: false,
  onTodo: vi.fn(async () => ({ output: 'todo ok' })),
  onAsk: vi.fn(async () => ({ output: 'ask ok' })),
  onTask: vi.fn(async () => ({ output: 'task ok' })),
  onApprove,
})

describe('dispatchCoworkTool and the approval card', () => {
  beforeEach(() => {
    executeAgentTool.mockReset()
    executeAgentTool.mockResolvedValue({ content: 'ok' })
    useToolApprovalRequests.setState({ editedInputs: {}, refusalReasons: {} })
  })

  it('runs the command the person edited, not the original', async () => {
    const out = await dispatchCoworkTool(
      {
        toolCallId: 'e1',
        toolName: 'bash',
        input: { command: 'rm -rf build && npm run build', timeout: 5 },
      },
      ctx(async () => {
        useToolApprovalRequests.setState({
          editedInputs: { e1: { command: 'rm -r build && npm run build' } },
        })
        return true
      })
    )
    expect(out.isError).toBeFalsy()
    expect(executeAgentTool).toHaveBeenCalledTimes(1)
    expect(executeAgentTool.mock.calls[0][1]).toEqual({
      command: 'rm -r build && npm run build',
      timeout: 5,
    })
    expect(useToolApprovalRequests.getState().editedInputs.e1).toBeUndefined()
  })

  it('shows the edited command in the row and tells the model it was edited (BUG-042)', async () => {
    const call = {
      toolCallId: 'e2',
      toolName: 'bash',
      input: { command: 'echo D042 > out.txt' },
    }
    const out = await dispatchCoworkTool(
      call,
      ctx(async () => {
        useToolApprovalRequests.setState({
          editedInputs: { e2: { command: 'echo D042EDITED > out.txt' } },
        })
        return true
      })
    )
    expect(out.ranInput).toEqual({ command: 'echo D042EDITED > out.txt' })
    expect(out.output).toContain('The user edited the command')
    expect(out.output).toContain('echo D042EDITED > out.txt')
    expect(out.output).toContain('ok')
    const step = { text: '', toolCalls: [call] } as never
    const outcomes = new Map([['e2', out]])
    const [turn] = turnsFor(step, outcomes)
    expect(turn.args).toEqual({ command: 'echo D042EDITED > out.txt' })
    const message = assistantMessageFor('m', step, outcomes) as unknown as {
      parts: { input: unknown }[]
    }
    expect(message.parts[0].input).toEqual({ command: 'echo D042EDITED > out.txt' })
  })

  it('leaves an unedited call as the model sent it', async () => {
    const out = await dispatchCoworkTool(
      { toolCallId: 'e3', toolName: 'bash', input: { command: 'echo hi' } },
      ctx(async () => true)
    )
    expect(out.ranInput).toBeUndefined()
    expect(out.output).not.toContain('edited')
  })

  it('tells the model the reason given with a deny, and forgets it', async () => {
    const out = await dispatchCoworkTool(
      { toolCallId: 'd1', toolName: 'bash', input: { command: 'rm -rf /' } },
      ctx(async () => {
        useToolApprovalRequests.setState({
          refusalReasons: { d1: 'use the trash instead' },
        })
        return false
      })
    )
    expect(out.isError).toBe(true)
    expect(out.output).toContain('use the trash instead')
    expect(executeAgentTool).not.toHaveBeenCalled()
    expect(useToolApprovalRequests.getState().refusalReasons.d1).toBeUndefined()
  })

  it('drops an edit left for a call that was refused', async () => {
    await dispatchCoworkTool(
      { toolCallId: 'x1', toolName: 'bash', input: { command: 'rm -rf a' } },
      ctx(async () => {
        useToolApprovalRequests.setState({
          editedInputs: { x1: { command: 'rm a' } },
        })
        return false
      })
    )
    expect(useToolApprovalRequests.getState().editedInputs.x1).toBeUndefined()
  })
})
