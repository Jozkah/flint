import { useState } from 'react'
import { TopBack } from '../shell/TopBar'
import { I, type IconId } from '../ui/icons'
import { Empty, Pills } from '../ui/bits'
import { ago } from '../ui/format'
import { respond } from '../ui/respond'
import { go, openSheet, useApp } from '../state/app'
import { useRpc } from '../state/rpc'
import { routeFor, useSessions } from '../state/sessions'

const ICON: Record<string, [IconId, string]> = {
  approval: ['shield', 'var(--tk-appr)'],
  run: ['check', 'var(--success)'],
  room: ['hand', 'var(--warning)'],
  info: ['bell', 'var(--info)'],
}

export default function Notifications() {
  const [filter, setFilter] = useState<'all' | 'approval' | 'run' | 'room'>('all')
  const notices = useApp((s) => s.notices)
  const computer = useApp((s) => s.computerName) ?? 'Your computer'
  const { data } = useRpc('approvals.list', {})
  const { sessions } = useSessions()
  const approvals = data?.approvals ?? []
  const shown = notices.filter((n) => n.kind !== 'approval' && (filter === 'all' || n.kind === filter))
  return (
    <>
      <TopBack
        crumb={computer}
        title="Notifications"
        action={
          <button type="button" className="ib" onClick={() => openSheet('notifset')} aria-label="Notification settings">
            <I n="sliders" />
          </button>
        }
      />
      <div className="scroll">
        <Pills
          items={[
            { id: 'all', label: 'All' },
            { id: 'approval', label: 'Approvals' },
            { id: 'run', label: 'Runs' },
            { id: 'room', label: 'Rooms' },
          ]}
          value={filter}
          onChange={setFilter}
        />
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
                    Approval waiting
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
                      Deny
                    </button>
                    <button type="button" className="btn sm pri" onClick={() => void respond(a, 'allow')}>
                      Allow once
                    </button>
                    <button type="button" className="btn sm" onClick={() => go(routeFor(a.threadId, sessions))}>
                      Open
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
            Nothing new. Approvals, finished runs and rooms waiting for you show up here while Flint is open on this phone.
          </Empty>
        )}
      </div>
    </>
  )
}
