import { describe, it, expect, beforeEach, vi } from 'vitest'

const toast = vi.hoisted(() => ({ warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { toolApproval: 'tool-approval-settings' },
}))
vi.mock('zustand/middleware', () => ({
  persist: (fn: unknown) => fn,
  createJSONStorage: () => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }),
}))

import {
  APPROVAL_WAIT_REMINDER_MS,
  approvalsWaitingTooLong,
} from '../useApprovalWaitNotifier'
import {
  useToolApprovalRequests,
  type PendingApproval,
} from '../useToolApprovalRequests'

const entry = (requestId: string, requestedAt?: number) =>
  ({ requestId, toolCallId: requestId, toolName: 'bash', threadId: 't', requestedAt, resolve: () => {} }) as PendingApproval

describe('approval wait reminders', () => {
  beforeEach(() => {
    toast.warning.mockReset()
    useToolApprovalRequests.setState({ pending: {}, queued: {} })
  })

  it('picks prompts waiting over 30 s, once each', () => {
    const now = 100_000
    const old = entry('a', now - APPROVAL_WAIT_REMINDER_MS - 1)
    const fresh = entry('b', now - 1_000)
    expect(approvalsWaitingTooLong([old, fresh, entry('c')], now, new Set())).toEqual([old])
    expect(approvalsWaitingTooLong([old], now, new Set(['a']))).toEqual([])
  })

  it('stamps when a prompt was raised', () => {
    void useToolApprovalRequests.getState().requestApproval('c1', 'bash', 't1')
    expect(useToolApprovalRequests.getState().pending['c1'].requestedAt).toBeTypeOf('number')
  })

  it('tells the user when leaving a chat cancels its prompts', async () => {
    const answer = useToolApprovalRequests.getState().requestApproval('c1', 'bash', 't1')
    useToolApprovalRequests.getState().clearPendingForThread('t1', { notify: true })
    await expect(answer).resolves.toBe(false)
    expect(toast.warning).toHaveBeenCalledWith(
      'Approval for bash was cancelled',
      expect.anything()
    )
  })

  it('stays quiet without notify', () => {
    void useToolApprovalRequests.getState().requestApproval('c1', 'bash', 't1')
    useToolApprovalRequests.getState().clearPendingForThread('t1')
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
