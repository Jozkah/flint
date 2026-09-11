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

describe('a prompt whose run stops is withdrawn', () => {
  beforeEach(() => {
    useToolApprovalRequests.setState({ pending: {}, queued: {} })
    useToolApproval.setState({
      approvedTools: {},
      approvedServers: [],
      approvedToolsGlobal: [],
      allowAllMCPPermissions: false,
    })
  })

  it('removes the shown prompt and answers it no', async () => {
    const run = new AbortController()
    const answer = store().requestApproval('c1', 'write', 's1', undefined, undefined, undefined, run.signal)
    const requestId = store().pending['c1'].requestId
    run.abort('cancelled')
    await expect(answer).resolves.toBe(false)
    expect(store().pending['c1']).toBeUndefined()
    // A click that arrives late names a request that is gone, and does nothing.
    store().resolveApproval('c1', 'allow-once', requestId)
    expect(store().pending['c1']).toBeUndefined()
  })

  it('removes a queued prompt without touching the one shown for another run', async () => {
    const mine = new AbortController()
    const shown = store().requestApproval('c1', 'write', 'child-a')
    const queued = store().requestApproval('c1', 'write', 'child-b', undefined, undefined, undefined, mine.signal)
    expect(store().queued['c1']).toHaveLength(1)
    mine.abort('cancelled')
    await expect(queued).resolves.toBe(false)
    expect(store().queued['c1']).toBeUndefined()
    expect(store().pending['c1'].threadId).toBe('child-a')
    store().resolveApproval('c1', 'allow-once')
    await expect(shown).resolves.toBe(true)
  })

  it('never shows a prompt for a run that has already stopped', async () => {
    const run = new AbortController()
    run.abort('cancelled')
    await expect(
      store().requestApproval('c1', 'write', 's1', undefined, undefined, undefined, run.signal)
    ).resolves.toBe(false)
    expect(store().pending['c1']).toBeUndefined()
  })
})
