import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  requestApproval: vi.fn(),
  executeCampaignTool: vi.fn(),
  eligible: vi.fn(),
}))

vi.mock('@/hooks/useToolApprovalRequests', () => ({
  useToolApprovalRequests: { getState: () => ({ requestApproval: m.requestApproval }) },
}))
vi.mock('@/lib/campaignTools', () => ({
  executeCampaignTool: m.executeCampaignTool,
  isCoordinatorEligible: m.eligible,
}))
vi.mock('@/lib/campaignHost', () => ({
  createToolDeps: () => ({ deps: true }),
  getCampaignRunner: () => null,
}))

import { createApprovalHooks } from '../approvalHooks'
import { createRunState } from '../runState'

const make = (over: Partial<Parameters<typeof createApprovalHooks>[0]> = {}) => {
  const ctx = {
    rs: createRunState([]),
    sid: 's1',
    runId: 'r1',
    folder: '/proj' as string | null,
    campaign: undefined,
    storedMode: 'ask' as never,
    selectedProvider: 'openai',
    modelId: 'gpt',
    pickFolder: vi.fn(),
    holdFolder: vi.fn(),
    ...over,
  }
  return { ctx, hooks: createApprovalHooks(ctx) }
}

describe('createApprovalHooks, characterized', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.eligible.mockReturnValue(false)
  })

  it('asks for an MCP call with the server named and the session streak', async () => {
    m.requestApproval.mockResolvedValue(true)
    const { hooks } = make()
    const signal = new AbortController().signal
    await expect(hooks.onApproveMcp!('c1', 'tool', { a: 1 }, 'srv', signal)).resolves.toBe(true)
    expect(m.requestApproval).toHaveBeenCalledWith('c1', 'tool', 's1', 'srv', {
      input: { a: 1 },
      workspaceLabel: '/proj',
      autoApproveStreak: 's1',
      signal,
    })
  })

  it('passes a forced approval as always-ask with its reason', async () => {
    m.requestApproval.mockResolvedValue(false)
    const { hooks } = make({ folder: null })
    const onDecision = vi.fn()
    await hooks.onApprove!('c1', 'bash', {}, undefined, undefined, {
      reason: 'why',
      conversationProgram: undefined,
      onDecision,
    } as never)
    expect(m.requestApproval).toHaveBeenCalledWith(
      'c1',
      'bash',
      's1',
      undefined,
      expect.objectContaining({ alwaysAsk: true, taskContext: 'why', onDecision, workspaceLabel: undefined })
    )
  })

  it('offers a folder once per run, and holds the pick on yes', async () => {
    m.requestApproval.mockResolvedValue(true)
    const { ctx, hooks } = make({ folder: null })
    ctx.pickFolder.mockResolvedValue('/picked')
    const signal = new AbortController().signal
    await expect(hooks.onNeedFolder!({ signal } as never)).resolves.toBe('attached')
    expect(m.requestApproval).toHaveBeenCalledWith(
      'r1:attach-folder',
      'attach_folder',
      's1',
      undefined,
      expect.objectContaining({ alwaysAsk: true, signal })
    )
    expect(ctx.holdFolder).toHaveBeenCalledWith('/picked')
    await expect(hooks.onNeedFolder!({ signal } as never)).resolves.toBe('declined')
    expect(m.requestApproval).toHaveBeenCalledTimes(1)
  })

  it('declines when the user says no or picks nothing', async () => {
    m.requestApproval.mockResolvedValueOnce(false)
    const a = make()
    await expect(a.hooks.onNeedFolder!({} as never)).resolves.toBe('declined')
    expect(a.ctx.pickFolder).not.toHaveBeenCalled()
    m.requestApproval.mockResolvedValueOnce(true)
    const b = make()
    b.ctx.pickFolder.mockResolvedValue(null)
    await expect(b.hooks.onNeedFolder!({} as never)).resolves.toBe('declined')
    expect(b.ctx.holdFolder).not.toHaveBeenCalled()
  })

  it('has campaign tools only for an eligible session with a folder', () => {
    expect(make().hooks.onCampaign).toBeUndefined()
    m.eligible.mockReturnValue(true)
    expect(make({ folder: null }).hooks.onCampaign).toBeUndefined()
    expect(make().hooks.onCampaign).toBeTypeOf('function')
  })

  it('runs a campaign call with the session mode, folder and model', () => {
    m.eligible.mockReturnValue(true)
    const { hooks } = make()
    const signal = new AbortController().signal
    void hooks.onCampaign!({ toolCallId: 'c' } as never, signal)
    expect(m.executeCampaignTool).toHaveBeenCalledWith(
      { toolCallId: 'c' },
      expect.objectContaining({
        sessionId: 's1',
        mode: 'ask',
        sourceRoot: '/proj',
        model: { provider: 'openai', id: 'gpt' },
        signal,
      }),
      { deps: true }
    )
  })
})
