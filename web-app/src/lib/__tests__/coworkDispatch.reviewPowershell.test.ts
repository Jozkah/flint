import { describe, it, expect, vi } from 'vitest'

const { executeAgentTool } = vi.hoisted(() => ({ executeAgentTool: vi.fn() }))
const { previewAgentChange } = vi.hoisted(() => ({
  previewAgentChange: vi.fn(async (): Promise<string | undefined> => undefined),
}))
vi.mock('@/lib/agentTools', () => ({ executeAgentTool, previewAgentChange }))

import { dispatchCoworkTool, reviewOnlyPowershellRefusal } from '../coworkDispatch'
import type { CoworkMode } from '../coworkMode'

const ctx = (mode: CoworkMode, onApprove = vi.fn(async () => true)) => ({
  sessionId: 's1',
  readOnlyFolder: 'C:/proj',
  mode,
  webSearch: false,
  onTodo: vi.fn(async () => ({ output: 'todo ok' })),
  onAsk: vi.fn(async () => ({ output: 'ask ok' })),
  onTask: vi.fn(async () => ({ output: 'task ok' })),
  onApprove,
})

describe('host_powershell in Review only (D3)', () => {
  it('is refused before asking when it would run in the read-only project folder', async () => {
    const onApprove = vi.fn(async () => true)
    const out = await dispatchCoworkTool(
      { toolCallId: 'p1', toolName: 'host_powershell', input: { script: 'Get-ChildItem' } },
      ctx('review', onApprove)
    )
    expect(out.isError).toBe(true)
    expect(out.output).toContain('Review only')
    expect(onApprove).not.toHaveBeenCalled()
    expect(executeAgentTool).not.toHaveBeenCalled()
  })

  it('names the project folder spelled differently as the same folder', () => {
    const refusal = reviewOnlyPowershellRefusal(
      { toolCallId: 'p2', toolName: 'host_powershell', input: { script: 'x', cwd: 'c:\\proj\\' } },
      { mode: 'review', readOnlyFolder: 'C:/proj' }
    )
    expect(refusal?.isError).toBe(true)
  })

  it('lets a call that names another folder, or another mode, go on to the prompt', () => {
    expect(
      reviewOnlyPowershellRefusal(
        { toolCallId: 'p3', toolName: 'host_powershell', input: { script: 'x', cwd: 'C:/ws' } },
        { mode: 'review', readOnlyFolder: 'C:/proj' }
      )
    ).toBeNull()
    expect(
      reviewOnlyPowershellRefusal(
        { toolCallId: 'p4', toolName: 'host_powershell', input: { script: 'x' } },
        { mode: 'ask', readOnlyFolder: 'C:/proj' }
      )
    ).toBeNull()
  })
})
