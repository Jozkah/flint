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

describe('a paused room keeps its prompt on screen, held', () => {
  beforeEach(() => {
    useToolApprovalRequests.setState({ pending: {}, queued: {} })
    useToolApproval.setState({
      approvedTools: {},
      approvedServers: [],
      approvedToolsGlobal: [],
      allowAllMCPPermissions: false,
    })
  })

  it('answers the stopped run no, but keeps the card marked paused', async () => {
    const run = new AbortController()
    const answer = store().requestApproval('c1', 'write', 'room-1', undefined, {
      signal: run.signal,
      holdOnAbort: () => 'room paused',
    })
    run.abort()
    await expect(answer).resolves.toBe(false)
    expect(store().pending['c1']?.held).toBe('room paused')
  })

  it('never turns an allow on a held card into a grant or a run', async () => {
    const run = new AbortController()
    const onDecision = vi.fn()
    void store().requestApproval('c1', 'write', 'room-1', undefined, {
      signal: run.signal,
      holdOnAbort: () => 'room paused',
      onDecision,
    })
    run.abort()
    const requestId = store().pending['c1'].requestId
    store().resolveApproval('c1', 'allow-always', requestId)
    store().resolveApproval('c1', 'allow-once', requestId)
    expect(onDecision).not.toHaveBeenCalled()
    expect(useToolApproval.getState().isToolApproved('room-1', 'write')).toBe(false)
    expect(store().pending['c1']?.held).toBe('room paused')
    // Deny clears it.
    store().resolveApproval('c1', 'deny', requestId)
    expect(store().pending['c1']).toBeUndefined()
  })

  it('expires held cards of a room when it resumes, and leaves others', async () => {
    const a = new AbortController()
    void store().requestApproval('c1', 'write', 'room-1', undefined, { signal: a.signal, holdOnAbort: () => 'room paused' })
    const other = store().requestApproval('c2', 'write', 'room-2')
    a.abort()
    store().expireHeld('room-1')
    expect(store().pending['c1']).toBeUndefined()
    expect(store().pending['c2']).toBeDefined()
    store().resolveApproval('c2', 'allow-once')
    await expect(other).resolves.toBe(true)
  })

  it('a stop that is not a pause withdraws as before', async () => {
    const run = new AbortController()
    const answer = store().requestApproval('c1', 'write', 'room-1', undefined, {
      signal: run.signal,
      holdOnAbort: () => null,
    })
    run.abort()
    await expect(answer).resolves.toBe(false)
    expect(store().pending['c1']).toBeUndefined()
  })
})
