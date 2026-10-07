// One of the computer's other blocking prompts (a folder outside the session's
// folder, a site for the assistant's browser, overlapping team tasks, a local
// model out of context), with the answers the computer lets a phone give.
// Once answered it becomes one line saying so.
import type { RemotePrompt } from '@/lib/remote/protocol'
import { respondPrompt } from '../state/app'
import { useLive } from '../state/live'
import { usePhonePermissions } from './hooks'
import { ResolvedLine } from './live'
import { t } from '../i18n'

const HEAD: Record<RemotePrompt['kind'], string> = {
  access: t('prompt.access'),
  domain: t('prompt.domain'),
  conflict: t('prompt.conflict'),
  context: t('prompt.context'),
}

export function PromptCard({ p }: { p: RemotePrompt }) {
  const resolved = useLive((s) => s.resolved[p.id])
  const perms = usePhonePermissions()
  if (resolved) return <ResolvedLine r={resolved} />
  return (
    <div className="ap2" data-testid="prompt-card" data-prompt-kind={p.kind}>
      <div className="aph">
        <span>{HEAD[p.kind]}</span>
        {p.origin && <span className="apfrom">{t('common.from', { origin: p.origin })}</span>}
      </div>
      <div className="apt">{p.title}</div>
      {p.detail && <div className="apcmd">{p.detail}</div>}
      {p.body && <div className="apbody">{p.body}</div>}
      <div className="apf">
        <span style={{ flex: 1 }} />
        {perms.approvals ? (
          p.actions.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`btn${a.style === 'primary' ? ' pri' : a.style === 'danger' ? ' dan' : ''}`}
              onClick={() => void respondPrompt(p, a.id, a.label)}
            >
              {a.label}
            </button>
          ))
        ) : (
          <span className="apnote">{t('approval.answerOnComputer')}</span>
        )}
      </div>
    </div>
  )
}
