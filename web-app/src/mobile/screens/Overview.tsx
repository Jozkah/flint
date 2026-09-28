import { TopMain } from '../shell/TopBar'
import { I, type IconId } from '../ui/icons'
import { Empty } from '../ui/bits'
import { ago, greet } from '../ui/format'
import { go, useApp } from '../state/app'
import { useRpc } from '../state/rpc'
import { byKind, useSessions } from '../state/sessions'

const NOTICE_ICON: Record<string, [IconId, string]> = {
  approval: ['shield', 'var(--tk-appr)'],
  run: ['check', 'var(--success)'],
  room: ['rooms', 'var(--merged)'],
  info: ['bell', 'var(--info)'],
}

export default function Overview() {
  const { sessions } = useSessions()
  const status = useRpc('status', {})
  const models = useRpc('models.list', {})
  const notices = useApp((s) => s.notices)
  const cowork = byKind(sessions, 'cowork')
  const week = Date.now() - 7 * 24 * 3600 * 1000
  const kpis: [string, string, string][] = [
    ['Conversations this week', String(sessions.filter((s) => s.updatedAt >= week).length), `${sessions.length} in all`],
    ['Models loaded', String(status.data?.modelsLoaded ?? '—'), `${models.data?.models.length ?? 0} available`],
    ['Running now', String(status.data?.runs.length ?? '—'), 'Chats, Cowork and Rooms'],
    ['Approvals waiting', String(status.data?.approvalsWaiting ?? '—'), 'Across all sessions'],
  ]
  return (
    <>
      <TopMain crumb="Workspace" title="Usage overview" />
      <div className="scroll">
        <div className="ph">
          <h2>{greet()} 👋</h2>
          <p>Here's what's happening on your computer.</p>
        </div>
        <div className="kpis">
          {kpis.map(([k, v, s]) => (
            <div key={k} className="kpi">
              <small>{k}</small>
              <b>{v}</b>
              <em>{s}</em>
            </div>
          ))}
        </div>
        <div className="card2" style={{ marginBottom: 12 }}>
          <h4>
            <I n="activity" />
            Token Throughput
          </h4>
          <small className="muted">Token and speed charts are shown on the computer for now.</small>
        </div>
        <div className="card2" style={{ marginBottom: 12 }}>
          <h4>
            <I n="bell" />
            Latest Activity
          </h4>
          {notices.length === 0 && <small className="muted">Nothing since this phone connected.</small>}
          {notices.slice(0, 6).map((n) => {
            const [icon, color] = NOTICE_ICON[n.kind]
            return (
              <div key={n.id} className="act2" role={n.route ? 'button' : undefined} onClick={() => n.route && go(n.route)}>
                <I n={icon} style={{ color, marginTop: 2 }} />
                <span className="tx">
                  <b style={{ fontWeight: 500 }}>{n.title}</b>
                  <small>{n.body}</small>
                </span>
                <small className="subtle">{ago(n.at)}</small>
              </div>
            )
          })}
        </div>
        <div className="card2">
          <h4>
            <I n="cowork" />
            Agent Runs
          </h4>
          {cowork.length === 0 && <Empty>No Cowork sessions yet.</Empty>}
          {cowork.slice(0, 6).map((s) => (
            <button
              key={s.id}
              type="button"
              className="row"
              onClick={() => go({ name: 'cowork', id: s.id })}
              style={{ padding: '8px 0', borderTop: '.8px dashed var(--border)', borderRadius: 0 }}
            >
              <span className="tx">
                <b>{s.title || 'Untitled'}</b>
                <small>{s.group ?? 'No folder'} · {ago(s.updatedAt)}</small>
              </span>
              <span style={{ fontSize: 11.5, color: s.status === 'running' || s.status === 'waiting' ? 'var(--warning)' : 'var(--success)' }}>
                {s.status === 'running' ? 'Running' : s.status === 'waiting' ? 'Needs approval' : '✓ Done'}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
