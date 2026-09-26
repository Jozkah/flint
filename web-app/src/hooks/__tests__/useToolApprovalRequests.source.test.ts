/**
 * The audit logged an edit the user had allowed as an open "prompt:Write".
 * The renderer now tells the backend whether the user was asked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/hooks/useServiceHub', () => ({ getServiceHub: () => ({}) }))

import { approvalSourceFor, useToolApprovalRequests } from '../useToolApprovalRequests'
import { useToolApproval } from '../useToolApproval'

describe('approvalSourceFor', () => {
  beforeEach(() => {
    useToolApprovalRequests.setState({ pending: {}, queued: {}, answeredByPrompt: {} })
    useToolApproval.setState({ allowAllMCPPermissions: false })
  })

  it('is "prompted" for a call the user allowed in the prompt', async () => {
    const asked = useToolApprovalRequests
      .getState()
      .requestApproval('c1', 'write', 's1', undefined, { preview: 'diff' })
    useToolApprovalRequests.getState().resolveApproval('c1', 'allow-once')
    expect(await asked).toBe(true)
    expect(approvalSourceFor('c1')).toBe('prompted')
  })

  it('is "auto" for a call nothing asked about', () => {
    expect(approvalSourceFor('never-asked')).toBe('auto')
  })

  it('does not mark a denied call as prompted-allowed', async () => {
    const asked = useToolApprovalRequests
      .getState()
      .requestApproval('c2', 'write', 's1', undefined, { preview: 'diff' })
    useToolApprovalRequests.getState().resolveApproval('c2', 'deny')
    expect(await asked).toBe(false)
    expect(useToolApprovalRequests.getState().answeredByPrompt.c2).toBeUndefined()
  })
})
