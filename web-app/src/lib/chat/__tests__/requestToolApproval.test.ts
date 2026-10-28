import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requestApproval: vi.fn(async () => true),
  server: vi.fn((_name: string) => undefined as string | undefined),
}))

vi.mock('@/hooks/useToolApprovalRequests', () => ({
  useToolApprovalRequests: {
    getState: () => ({ requestApproval: h.requestApproval }),
  },
}))
vi.mock('@/lib/chat/threadHelpers', () => ({
  serverForTool: (name: string) => h.server(name),
}))

import {
  requestAlwaysAskApproval,
  requestToolApproval,
} from '../requestToolApproval'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

const call = { toolCallId: 'c1', toolName: 'read_file', input: { path: 'a' } }

describe('requestToolApproval', () => {
  beforeEach(() => {
    h.requestApproval.mockClear()
    h.server.mockReset()
  })

  it('asks with the tool server and the auto-approve streak of the thread', async () => {
    h.server.mockReturnValue('files')
    await expect(requestToolApproval(call, 't1')).resolves.toBe(true)
    expect(h.requestApproval).toHaveBeenCalledWith('c1', 'read_file', 't1', 'files', {
      input: { path: 'a' },
      threadIsEphemeral: false,
      autoApproveStreak: 't1',
    })
  })

  it('marks a temporary chat as ephemeral', async () => {
    await requestToolApproval(call, TEMPORARY_CHAT_ID)
    expect(h.requestApproval.mock.calls[0][4]).toMatchObject({
      threadIsEphemeral: true,
    })
  })
})

describe('requestAlwaysAskApproval', () => {
  beforeEach(() => h.requestApproval.mockClear())

  it('always asks, with its reason, no server and a checked destructive scan', async () => {
    const signal = new AbortController().signal
    await requestAlwaysAskApproval(call, 't1', { taskContext: 'why', signal })
    expect(h.requestApproval).toHaveBeenCalledWith('c1', 'read_file', 't1', undefined, {
      input: { path: 'a' },
      alwaysAsk: true,
      taskContext: 'why',
      destructiveChecked: true,
      threadIsEphemeral: false,
      signal,
    })
  })

  it('adds the scope fields between the reason and the checks', async () => {
    await requestAlwaysAskApproval(call, 't1', {
      taskContext: 'why',
      scope: { alwaysAsk: false },
    })
    const options = h.requestApproval.mock.calls[0][4] as Record<string, unknown>
    expect(options.alwaysAsk).toBe(false)
    expect(options.destructiveChecked).toBe(true)
  })
})
