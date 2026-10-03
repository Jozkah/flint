// A waiting permission prompt, as the desktop's approval card: "Approval
// needed · bash", what Flint wants to do, the command, Why, What allowing it
// means, Permission details, Deny / Allow once. Once answered -- here, on the
// computer or on another phone -- it becomes one line saying so.
import type { RemoteApproval } from '@/lib/remote/protocol'
import { openSheet } from '../state/app'
import { useLive } from '../state/live'
import { usePhonePermissions } from './hooks'
import { ResolvedLine } from './live'
import { respond } from './respond'

export function ApprovalCard({ a }: { a: RemoteApproval }) {
  const resolved = useLive((s) => s.resolved[a.requestId])
  const perms = usePhonePermissions()
  if (resolved) return <ResolvedLine r={resolved} />
  return (
    <div className="ap2" data-testid="approval-card">
      <div className="aph">
        <span>Approval needed</span>
        <span className="aptool">{a.toolName}</span>
        {a.origin && <span className="apfrom">from {a.origin}</span>}
      </div>
      <div className="apt">{a.title}</div>
      {a.subject && <div className="apcmd">{a.subject}</div>}
      {a.preview && (
        <details className="apdiff" data-testid="approval-diff">
          <summary>What would change</summary>
          <pre>
            {a.preview.split('\n').map((line, i) => (
              <span key={i} className={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : undefined}>
                {line}
                {'\n'}
              </span>
            ))}
          </pre>
        </details>
      )}
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
        {perms.approvals ? (
          <>
            <button type="button" className="btn dan" onClick={() => void respond(a, 'deny')}>
              Deny
            </button>
            <button type="button" className="btn pri" onClick={() => void respond(a, 'allow')}>
              Allow once
            </button>
          </>
        ) : (
          <span className="apnote">Answer this on the computer</span>
        )}
      </div>
    </div>
  )
}
