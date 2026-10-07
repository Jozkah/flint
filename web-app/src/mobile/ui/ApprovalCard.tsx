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
import { SlideCommit } from './slide-commit'
import { t } from '../i18n'

export function ApprovalCard({ a }: { a: RemoteApproval }) {
  const resolved = useLive((s) => s.resolved[a.requestId])
  const perms = usePhonePermissions()
  if (resolved) return <ResolvedLine r={resolved} />
  return (
    <div className="ap2" data-testid="approval-card">
      <div className="aph">
        <span>{t('approval.needed')}</span>
        <span className="aptool">{a.toolName}</span>
        {a.origin && <span className="apfrom">{t('common.from', { origin: a.origin })}</span>}
      </div>
      <div className="apt">{a.title}</div>
      {a.subject && <div className="apcmd">{a.subject}</div>}
      {a.preview && (
        <details className="apdiff" data-testid="approval-diff">
          <summary>{t('approval.whatWouldChange')}</summary>
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
              <dt>{t('approval.why')}</dt>
              <dd>{a.why}</dd>
            </>
          )}
          {a.consequences.length > 0 && (
            <>
              <dt>{t('approval.whatAllowingMeans')}</dt>
              <dd>{a.consequences.join(' ')}</dd>
            </>
          )}
        </dl>
      )}
      <div className="apf">
        <button type="button" className="apdet" onClick={() => openSheet('permdetails', { approval: a })}>
          {t('approval.details')}
        </button>
        <span style={{ flex: 1 }} />
        {perms.approvals ? (
          <>
            <button type="button" className="btn dan" onClick={() => void respond(a, 'deny')}>
              {t('common.deny')}
            </button>
            <SlideCommit
              label="Allow once"
              errorLabel="Didn’t work, try again"
              doneLabel="Allowed"
              testId="approval-allow"
              onCommit={async () => (await respond(a, 'allow')) !== undefined}
            />
          </>
        ) : (
          <span className="apnote">{t('approval.answerOnComputer')}</span>
        )}
      </div>
    </div>
  )
}
