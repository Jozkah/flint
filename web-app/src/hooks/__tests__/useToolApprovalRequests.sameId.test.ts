/**
 * Two approval requests under one call id. A team's children are separate
 * conversations, and a provider that numbers calls per response gives each
 * child's first call the same id (`call_0`). Keyed on the id alone, the second
 * request replaced the first and the first child waited forever, with no
 * prompt on screen -- found by the AH-109 Windows scenario.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/hooks/useServiceHub', () => ({ getServiceHub: () => ({}) }))

import { useToolApprovalRequests } from '../useToolApprovalRequests'
import { useToolApproval } from '../useToolApproval'

describe('approval requests that share a call id', () => {
  beforeEach(() => {
    useToolApprovalRequests.setState({ pending: {}, queued: {} })
    useToolApproval.setState({ allowAllMCPPermissions: false })
  })

  it('shows each in turn, and every one of them gets an answer', async () => {
    const store = useToolApprovalRequests.getState()
    const first = store.requestApproval('call_0', 'write', 's1', undefined, { preview: 'first diff' })
    const second = store.requestApproval('call_0', 'write', 's1', undefined, { preview: 'second diff' })
    const third = store.requestApproval('call_0', 'edit', 's1', undefined, { preview: 'third diff' })

    expect(useToolApprovalRequests.getState().pending.call_0.preview).toBe('first diff')
    useToolApprovalRequests.getState().resolveApproval('call_0', 'allow-once')
    expect(await first).toBe(true)

    expect(useToolApprovalRequests.getState().pending.call_0.preview).toBe('second diff')
    useToolApprovalRequests.getState().resolveApproval('call_0', 'deny')
    expect(await second).toBe(false)

    expect(useToolApprovalRequests.getState().pending.call_0.preview).toBe('third diff')
    useToolApprovalRequests.getState().resolveApproval('call_0', 'allow-once')
    expect(await third).toBe(true)

    expect(useToolApprovalRequests.getState().pending).toEqual({})
    expect(useToolApprovalRequests.getState().queued).toEqual({})
  })

  // A double-click on "Allow once": the second click arrives after the first
  // request is gone and the next one is shown under the same call id.
  it('an answer names its request, so a repeated answer cannot reach the next one', async () => {
    const store = useToolApprovalRequests.getState()
    const first = store.requestApproval('call_0', 'write', 's1', undefined, { preview: 'first diff' })
    const second = store.requestApproval('call_0', 'write', 's1', undefined, { preview: 'second diff' })
    const firstId = useToolApprovalRequests.getState().pending.call_0.requestId

    useToolApprovalRequests.getState().resolveApproval('call_0', 'allow-once', firstId)
    useToolApprovalRequests.getState().resolveApproval('call_0', 'allow-once', firstId)
    expect(await first).toBe(true)
    const shown = useToolApprovalRequests.getState().pending.call_0
    expect(shown.preview).toBe('second diff')
    expect(shown.requestId).not.toBe(firstId)

    let settled = false
    void second.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    useToolApprovalRequests.getState().resolveApproval('call_0', 'deny', shown.requestId)
    expect(await second).toBe(false)
  })

  it('a request still queued can be answered by its id, and the one shown stays', async () => {
    const store = useToolApprovalRequests.getState()
    const shown = store.requestApproval('call_0', 'write', 's2', undefined, { preview: 'other session' })
    const waiting = store.requestApproval('call_0', 'write', 's1', undefined, { preview: 'mine', origin: 'worker' })
    const queuedId = useToolApprovalRequests.getState().queued.call_0[0].requestId

    useToolApprovalRequests.getState().resolveApproval('call_0', 'allow-once', queuedId)
    expect(await waiting).toBe(true)
    expect(useToolApprovalRequests.getState().pending.call_0.preview).toBe('other session')
    expect(useToolApprovalRequests.getState().queued).toEqual({})
    useToolApprovalRequests.getState().resolveApproval('call_0', 'deny')
    expect(await shown).toBe(false)
  })

  it('clearing a session answers what was waiting too, and leaves other sessions’ requests', async () => {
    const store = useToolApprovalRequests.getState()
    const a = store.requestApproval('call_0', 'write', 's1')
    const b = store.requestApproval('call_0', 'write', 's1')
    const other = store.requestApproval('call_0', 'write', 's2')

    useToolApprovalRequests.getState().clearPendingForThread('s1')
    expect(await a).toBe(false)
    expect(await b).toBe(false)
    // The other session's request, queued behind s1's, is now the one shown.
    expect(useToolApprovalRequests.getState().pending.call_0.threadId).toBe('s2')
    useToolApprovalRequests.getState().resolveApproval('call_0', 'allow-once')
    expect(await other).toBe(true)
  })
})
