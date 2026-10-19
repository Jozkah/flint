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
const secret = [
  { file: 'lib/env.ts', line: 2, rule: 'API key', snippet: 'k = "[redacted]"' },
]

describe('the question about a write the credential scan stopped', () => {
  beforeEach(() => {
    useToolApprovalRequests.setState({
      pending: {},
      queued: {},
      refusals: {},
      refusalReasons: {},
    })
    useToolApproval.setState({
      approvedTools: {},
      approvedServers: [],
      approvedToolsGlobal: [],
      allowAllMCPPermissions: false,
      permissionMode: 'ask',
    })
  })

  it('carries the findings on the pending request', () => {
    void store().requestApproval('c1', 'write', 't1', undefined, {
      input: { path: 'lib/env.ts' },
      alwaysAsk: true,
      secret,
    })
    expect(store().pending['c1'].secret).toEqual(secret)
    expect(store().pending['c1'].alwaysAsk).toBe(true)
  })

  it('is asked even when this tool is already approved for the conversation and always', async () => {
    useToolApproval.setState({
      approvedTools: { t1: ['write'] },
      approvedToolsGlobal: ['write'],
      permissionMode: 'auto-approve',
    })
    const answer = store().requestApproval('c2', 'write', 't1', undefined, {
      input: { path: 'lib/env.ts' },
      alwaysAsk: true,
      secret,
    })
    expect(store().pending['c2']).toBeDefined()
    store().resolveApproval('c2', 'deny', store().pending['c2'].requestId)
    await expect(answer).resolves.toBe(false)
  })

  it('is answered for this one write: nothing is granted, so the next is asked again', async () => {
    const first = store().requestApproval('c3', 'write', 't1', undefined, {
      input: { path: 'lib/env.ts' },
      alwaysAsk: true,
      secret,
    })
    store().resolveApproval('c3', 'allow-once', store().pending['c3'].requestId)
    await expect(first).resolves.toBe(true)
    expect(useToolApproval.getState().approvedTools['t1'] ?? []).not.toContain('write')
    void store().requestApproval('c4', 'write', 't1', undefined, {
      input: { path: 'lib/env2.ts' },
      alwaysAsk: true,
      secret,
    })
    expect(store().pending['c4']).toBeDefined()
  })

  it('is passed straight through under Bypass', async () => {
    useToolApproval.setState({ permissionMode: 'bypass' })
    await expect(
      store().requestApproval('c5', 'write', 't1', undefined, {
        input: { path: 'lib/env.ts' },
        alwaysAsk: true,
        secret,
      })
    ).resolves.toBe(true)
    expect(store().pending['c5']).toBeUndefined()
  })
})
