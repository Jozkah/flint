import { useState } from 'react'
import { TopBack } from '../shell/TopBar'
import { I, type IconId } from '../ui/icons'
import { Empty, Pills } from '../ui/bits'
import { ago } from '../ui/format'
import { respond } from '../ui/respond'
import { PromptCard } from '../ui/PromptCard'
import { go, openSheet, useApp } from '../state/app'
import { useRpc } from '../state/rpc'
import { routeFor, useSessions } from '../state/sessions'
import { t } from '../i18n'

const ICON: Record<string, [IconId, string]> = {
  approval: ['shield', 'var(--tk-appr)'],
  run: ['check', 'var(--success)'],
  room: ['hand', 'var(--warning)'],
  info: ['bell', 'var(--info)'],
}

export default function Notifications() {
  const [filter, setFilter] = useState<'all' | 'approval' | 'run' | 'room'>('all')
  const notices = useApp((s) => s.notices)
  const computer = useApp((s) => s.computerName) ?? t('common.yourComputerCap')
  const { data } = useRpc('approvals.list', {})
  const { sessions } = useSessions()
  const approvals = data?.approvals ?? []
  const asks = useRpc('asks.list', {}).data?.asks ?? []
  const prompts = useRpc('prompts.list', {}).data?.prompts ?? []
  const shown = notices.filter((n) => n.kind !== 'approval' && (filter === 'all' || n.kind === filter))
  return (
    <>
      <TopBack
        crumb={computer}
        title={t('notifications.title')}
        action={
          <button type="button" className="ib" onClick={() => openSheet('notifset')} aria-label={t('notifications.settings')}>
            <I n="sliders" />
          </button>
        }
      />
      <div className="scroll">
        <Pills
          items={[
            { id: 'all', label: t('notifications.filters.all') },
            { id: 'approval', label: t('notifications.filters.approval') },
            { id: 'run', label: t('notifications.filters.run') },
            { id: 'room', label: t('notifications.filters.room') },
          ]}
          value={filter}
          onChange={setFilter}
        />
        {(filter === 'all' || filter === 'approval') && prompts.map((p) => <PromptCard key={p.id} p={p} />)}
        {(filter === 'all' || filter === 'approval') &&
          asks.map((a) => (
            <button
              key={a.requestId}
              type="button"
              className="frame"
              data-testid="notice-question"
              style={{ padding: '10px 12px', marginBottom: 6, display: 'flex', gap: 10, width: '100%', textAlign: 'left' }}
              onClick={() => go({ name: 'cowork', id: a.threadId })}
            >
              <span style={{ marginTop: 2 }}>
                <I n="hand" style={{ color: 'var(--warning)' }} />
              </span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <b style={{ fontWeight: 600, fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                  {t('notifications.question')}
                  {a.requestedAt && (
                    <small className="subtle" style={{ fontWeight: 400, fontSize: 11 }}>
                      {ago(a.requestedAt)}
                    </small>
                  )}
                </b>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {sessions.find((x) => x.id === a.threadId)?.title ? `${sessions.find((x) => x.id === a.threadId)?.title}: ` : ''}
                  {a.questions[0]?.question}
                </span>
              </span>
            </button>
          ))}
        {(filter === 'all' || filter === 'approval') &&
          approvals.map((a) => {
            const s = sessions.find((x) => x.id === a.threadId)
            return (
              <div key={a.requestId} className="frame" style={{ padding: '10px 12px', marginBottom: 6, display: 'flex', gap: 10 }}>
                <span style={{ marginTop: 2 }}>
                  <I n="shield" style={{ color: 'var(--tk-appr)' }} />
                </span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <b style={{ fontWeight: 600, fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                    {t('notifications.approval')}
                    {a.requestedAt && (
                      <small className="subtle" style={{ fontWeight: 400, fontSize: 11 }}>
                        {ago(a.requestedAt)}
                      </small>
                    )}
                  </b>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {s?.title ? `${s.title}: ` : ''}
                    {a.title}
                  </span>
                  <span style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                    <button type="button" className="btn sm dan" onClick={() => void respond(a, 'deny')}>
                      {t('common.deny')}
                    </button>
                    <button type="button" className="btn sm pri" onClick={() => void respond(a, 'allow')}>
                      {t('common.allowOnce')}
                    </button>
                    <button type="button" className="btn sm" onClick={() => go(routeFor(a.threadId, sessions))}>
                      {t('common.open')}
                    </button>
                  </span>
                </span>
              </div>
            )
          })}
        {shown.map((n) => {
          const [icon, color] = ICON[n.kind]
          return (
            <div
              key={n.id}
              className="frame"
              style={{ padding: '10px 12px', marginBottom: 6, display: 'flex', gap: 10, ...(n.unread ? {} : { background: 'none' }) }}
            >
              <span style={{ marginTop: 2 }}>
                <I n={icon} style={{ color }} />
              </span>
              <span
                style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, cursor: n.route ? 'pointer' : undefined }}
                onClick={() => n.route && go(n.route)}
              >
                <b style={{ fontWeight: 600, fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                  {n.title}
                  <small className="subtle" style={{ fontWeight: 400, fontSize: 11 }}>
                    {ago(n.at)}
                  </small>
                </b>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {n.body}
                </span>
              </span>
            </div>
          )
        })}
        {approvals.length === 0 && shown.length === 0 && (
          <Empty icon={<I n="bell" size={20} />}>
            {t('notifications.empty')}
          </Empty>
        )}
      </div>
    </>
  )
}
