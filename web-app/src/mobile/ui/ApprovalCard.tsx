// A waiting permission prompt, as the desktop's approval card: "Approval
// needed · bash", what Flint wants to do, the command, Why, What allowing it
// means, Permission details, Deny / Allow once.
import type { RemoteApproval } from '@/lib/remote/protocol'
import { openSheet } from '../state/app'
import { respond } from './respond'

export function ApprovalCard({ a }: { a: RemoteApproval }) {
  return (
    <div className="ap2" data-testid="approval-card">
      <div className="aph">
        <span>Approval needed</span>
        <span className="aptool">{a.toolName}</span>
      </div>
      <div className="apt">{a.title}</div>
      {a.subject && <div className="apcmd">{a.subject}</div>}
      {(a.why || a.consequences.length > 0) && (
        <dl className="apdl">
          {a.why && (
            <>
              <dt>Why</dt>
              <dd>{a.why}</dd>
            </>
          )}
          {a.consequences.length > 0 && (
            <>
              <dt>What allowing it means</dt>
              <dd>{a.consequences.join(' ')}</dd>
            </>
          )}
        </dl>
      )}
      <div className="apf">
        <button type="button" className="apdet" onClick={() => openSheet('permdetails', { approval: a })}>
          Permission details
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn dan" onClick={() => void respond(a, 'deny')}>
          Deny
        </button>
        <button type="button" className="btn pri" onClick={() => void respond(a, 'allow')}>
          Allow once
        </button>
      </div>
    </div>
  )
}
