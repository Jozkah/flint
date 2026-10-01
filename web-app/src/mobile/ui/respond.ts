import type { ApprovalRespondParams, RemoteApproval } from '@/lib/remote/protocol'
import { respondApproval } from '../state/app'

/** Answers an approval from this phone; the computer decides whether it may. */
export function respond(
  a: Pick<RemoteApproval, 'requestId' | 'threadId'>,
  decision: 'allow' | 'deny',
  scope: NonNullable<ApprovalRespondParams['scope']> = 'once',
  label?: string
) {
  return respondApproval(a, decision, scope, label)
}
