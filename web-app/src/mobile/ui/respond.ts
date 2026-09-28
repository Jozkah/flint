import type { RemoteApproval } from '@/lib/remote/protocol'
import { act } from '../state/app'

/** Answers an approval from this phone; the computer decides whether it may. */
export function respond(a: RemoteApproval, decision: 'allow' | 'deny', scope: 'once' | 'thread' | 'always' = 'once') {
  return act(
    'approvals.respond',
    { requestId: a.requestId, decision, ...(decision === 'allow' ? { scope } : {}) },
    decision === 'deny' ? 'Denied · from this phone' : 'Allowed once · from this phone'
  )
}
