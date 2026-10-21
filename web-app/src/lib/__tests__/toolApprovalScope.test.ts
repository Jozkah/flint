import { describe, expect, it } from 'vitest'
import type { PendingApproval } from '@/hooks/useToolApprovalRequests'
import { approvalForCall } from '../toolApprovalScope'

const entry = (threadId: string, requestId: string) =>
  ({ toolCallId: 'same', threadId, requestId }) as PendingApproval

describe('approvalForCall', () => {
  const a = entry('A', 'ra')
  const b = entry('B', 'rb')
  const state = { pending: { same: a }, queued: { same: [b] } }

  it('returns the head when no thread is known', () => {
    expect(approvalForCall(state, 'same', undefined)).toBe(a)
  })

  it('returns the request owned by the card thread, head or queued', () => {
    expect(approvalForCall(state, 'same', 'A')).toBe(a)
    expect(approvalForCall(state, 'same', 'B')).toBe(b)
  })

  it('shows nothing for a thread that owns no request under that id', () => {
    expect(approvalForCall(state, 'same', 'C')).toBeUndefined()
    expect(approvalForCall({ pending: { same: a } }, 'same', 'B')).toBeUndefined()
    expect(approvalForCall(state, undefined, 'A')).toBeUndefined()
  })
})
