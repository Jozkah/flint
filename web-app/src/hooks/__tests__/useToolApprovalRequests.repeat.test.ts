import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import {
  useToolApprovalRequests,
  wasCommandAllowedOnce,
} from '../useToolApprovalRequests'
import { useToolApproval } from '../useToolApproval'

vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { toolApproval: 'tool-approval-settings' },
}))
vi.mock('zustand/middleware', () => ({
  persist: (fn: any) => fn,
  createJSONStorage: () => ({
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }),
}))

const ask = (id: string, command: string, thread = 't1', tool = 'bash') => {
  let p!: Promise<boolean>
  act(() => {
    p = useToolApprovalRequests
      .getState()
      .requestApproval(id, tool, thread, undefined, { input: { command } })
  })
  return p
}

const seen = (command: string, thread = 't1', tool = 'bash') =>
  wasCommandAllowedOnce(
    useToolApprovalRequests.getState(),
    thread,
    tool,
    { command }
  )

describe('allowed-once command memory', () => {
  beforeEach(() => {
    useToolApprovalRequests.setState({
      pending: {},
      queued: {},
      allowedOnceCommands: {},
    })
    useToolApproval.setState({
      approvedTools: {},
      approvedMcpTools: {},
      approvedServers: [],
      approvedToolsGlobal: [],
      invalidatedServers: [],
      allowAllMCPPermissions: false,
    })
  })

  it('remembers a bash command answered allow-once, for that thread only', async () => {
    const p = ask('tc1', 'npm test')
    act(() => useToolApprovalRequests.getState().resolveApproval('tc1', 'allow-once'))
    await expect(p).resolves.toBe(true)
    expect(seen('npm test')).toBe(true)
    expect(seen(' npm test\n')).toBe(true)
    expect(seen('npm test', 't2')).toBe(false)
    expect(seen('npm run build')).toBe(false)
  })

  it('never approves the repeat by itself', () => {
    void ask('tc1', 'npm test')
    act(() => useToolApprovalRequests.getState().resolveApproval('tc1', 'allow-once'))
    void ask('tc2', 'npm test')
    expect(useToolApprovalRequests.getState().pending['tc2']).toBeDefined()
    expect(useToolApproval.getState().approvedTools).toEqual({})
  })

  it('remembers nothing for deny, broader grants, or other tools', () => {
    void ask('tc1', 'a')
    act(() => useToolApprovalRequests.getState().resolveApproval('tc1', 'deny'))
    void ask('tc2', 'b')
    act(() => useToolApprovalRequests.getState().resolveApproval('tc2', 'allow-thread'))
    void ask('tc3', 'c', 't1', 'write')
    act(() => useToolApprovalRequests.getState().resolveApproval('tc3', 'allow-once'))
    expect(useToolApprovalRequests.getState().allowedOnceCommands).toEqual({})
  })
})
