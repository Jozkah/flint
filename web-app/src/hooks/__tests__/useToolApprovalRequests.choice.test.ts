import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useToolApprovalRequests } from '../useToolApprovalRequests'
import { useToolApproval } from '../useToolApproval'

vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { toolApproval: 'tool-approval-settings' },
}))
vi.mock('zustand/middleware', () => ({
  persist: (fn: any) => fn,
  createJSONStorage: () => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }),
}))

const store = () => useToolApprovalRequests.getState()
const choice = {
  question: 'How should the tasks work?',
  options: [
    { id: 'worktree', label: 'On their own' },
    { id: 'ask', label: 'Ask for each action' },
  ],
  defaultId: 'worktree',
}

describe('an approval that asks for a choice with its answer', () => {
  beforeEach(() => {
    useToolApprovalRequests.setState({ pending: {}, queued: {} })
    useToolApproval.setState({
      approvedTools: {},
      approvedServers: [],
      approvedToolsGlobal: [],
      allowAllMCPPermissions: false,
    })
  })

  it('reports the recommended option when the person never touched the choice', async () => {
    const seen: (string | undefined)[] = []
    const answer = store().requestApproval('c1', 'campaign_plan', 's1', undefined, {
      alwaysAsk: true,
      choice,
      onDecision: (_d, id) => seen.push(id),
    })
    expect(store().pending['c1'].chosenId).toBe('worktree')
    store().resolveApproval('c1', 'allow-once')
    await expect(answer).resolves.toBe(true)
    expect(seen).toEqual(['worktree'])
  })

  it('reports the option picked, ignores unknown ones and stale requests', async () => {
    const seen: (string | undefined)[] = []
    const answer = store().requestApproval('c1', 'campaign_plan', 's1', undefined, {
      alwaysAsk: true,
      choice,
      onDecision: (_d, id) => seen.push(id),
    })
    const requestId = store().pending['c1'].requestId
    store().chooseOption('c1', requestId, 'nope')
    expect(store().pending['c1'].chosenId).toBe('worktree')
    store().chooseOption('c1', 'other-request', 'ask')
    expect(store().pending['c1'].chosenId).toBe('worktree')
    store().chooseOption('c1', requestId, 'ask')
    expect(store().pending['c1'].chosenId).toBe('ask')
    store().resolveApproval('c1', 'allow-once', requestId)
    await expect(answer).resolves.toBe(true)
    expect(seen).toEqual(['ask'])
  })

  it('a request without a choice reports none', async () => {
    const seen: (string | undefined)[] = []
    const answer = store().requestApproval('c2', 'write', 's1', undefined, {
      onDecision: (_d, id) => seen.push(id),
    })
    store().resolveApproval('c2', 'allow-once')
    await answer
    expect(seen).toEqual([undefined])
  })
})
