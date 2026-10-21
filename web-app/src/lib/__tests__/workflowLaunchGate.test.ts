import { describe, expect, it, vi } from 'vitest'
import {
  WORKFLOW_APPROVAL_AGENTS,
  gateWorkflowLaunch,
  phaseSizes,
} from '@/lib/workflowLaunchGate'
import type { PendingToolCall } from '@/lib/coworkRunner'

const flow = (n: number): PendingToolCall => ({
  toolCallId: 'w1',
  toolName: 'workflow',
  input: {
    phases: [
      { name: 'A', agents: Array.from({ length: n - 1 }, () => ({ description: 'd' })) },
      { name: 'B', agents: [{ description: 'd' }] },
    ],
  },
})

describe('gateWorkflowLaunch', () => {
  const big = WORKFLOW_APPROVAL_AGENTS + 1

  it('counts agents per phase', () => {
    expect(phaseSizes(flow(5).input)).toEqual([4, 1])
  })

  it('does not ask for a run at or under the limit', async () => {
    const onApprove = vi.fn(async () => true)
    const out = await gateWorkflowLaunch(flow(WORKFLOW_APPROVAL_AGENTS), { mode: 'ask', onTeam: {}, onApprove })
    expect(out).toBeNull()
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('asks once for a large run and lets a yes through', async () => {
    const onApprove = vi.fn(async () => true)
    const out = await gateWorkflowLaunch(flow(big), { mode: 'ask', onTeam: {}, onApprove })
    expect(out).toBeNull()
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onApprove.mock.calls[0].slice(0, 2)).toEqual(['w1', 'workflow'])
  })

  it('refuses on a no, and when nothing can ask', async () => {
    const no = await gateWorkflowLaunch(flow(big), { mode: 'ask', onTeam: {}, onApprove: async () => false })
    expect(no?.isError).toBe(true)
    expect(no?.output).toContain('did not allow')
    const mute = await gateWorkflowLaunch(flow(big), { mode: 'ask', onTeam: {} })
    expect(mute?.isError).toBe(true)
  })

  it('never asks in review mode, bypass, or inside a subagent', async () => {
    const onApprove = vi.fn(async () => false)
    for (const ctx of [
      { mode: 'review' as const, onTeam: {}, onApprove },
      { mode: 'bypass' as const, onTeam: {}, onApprove },
      { mode: 'ask' as const, onApprove },
    ]) {
      expect(await gateWorkflowLaunch(flow(big), ctx)).toBeNull()
    }
    expect(onApprove).not.toHaveBeenCalled()
  })
})
