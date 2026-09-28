// The desktop's side panel and inspector, as a drawer from the right.
import type { ReactNode } from 'react'
import type { CoworkDetail, RemoteToolStep } from '@/lib/remote/protocol'
import { Avatar, Empty, Kv, Sw } from '../ui/bits'
import { compact, duration, speakerColor } from '../ui/format'
import { I, type IconId } from '../ui/icons'
import { act, app, closeAll, notYet, openSheet, useApp } from '../state/app'
import { useRpc } from '../state/rpc'
import { accessLabel, modeLabel } from './labels'

function Header({ title }: { title: string }) {
  return (
    <>
      <div className="dpad" />
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px 8px 14px', gap: 6 }}>
        <b style={{ flex: 1, fontSize: 15 }}>{title}</b>
        <button type="button" className="ib" onClick={closeAll} aria-label="Close">
          <I n="x" />
        </button>
      </div>
    </>
  )
}

function Tabs({ tabs, current }: { tabs: [string, IconId, string][]; current: string }) {
  return (
    <div className="rtabs" role="tablist">
      {tabs.map(([id, icon, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={current === id}
          onClick={() => app.set({ rightTab: id })}
        >
          <I n={icon} />
          {label}
        </button>
      ))}
    </div>
  )
}

function Soon({ what }: { what: string }) {
  return <Empty icon={<I n="monitor" size={18} />}>{what} are shown on the computer for now.</Empty>
}

// ---------------------------------------------------------------------------

const COWORK_TABS: [string, IconId, string][] = [
  ['changes', 'plus', 'Changes'],
  ['activity', 'activity', 'Activity'],
  ['timeline', 'timeline', 'Timeline'],
  ['progress', 'todo', 'Progress'],
  ['code', 'code', 'Code'],
  ['preview', 'eye', 'Preview'],
  ['details', 'info', 'Details'],
]

export function ProgressCard({ detail }: { detail: CoworkDetail }) {
  const done = detail.todos.filter((t) => t.status === 'completed').length
  return (
    <div className="card2">
      <h4>
        <I n="todo" />
        Progress
        <span className="muted" style={{ marginLeft: 'auto', fontWeight: 400, fontSize: 12 }}>
          {done} of {detail.todos.length} done
        </span>
      </h4>
      {detail.todos.map((t, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
          {t.status === 'completed' ? (
            <I n="check" style={{ color: 'var(--success)' }} />
          ) : t.status === 'in_progress' ? (
            <I n="loader" spin style={{ color: 'var(--warning)' }} />
          ) : (
            <span style={{ width: 16, height: 16, borderRadius: '50%', border: '1.5px solid var(--border-strong)', flex: 'none' }} />
          )}
          <span style={t.status === 'completed' ? { color: 'var(--muted-foreground)', textDecoration: 'line-through' } : undefined}>
            {t.text}
          </span>
        </div>
      ))}
    </div>
  )
}

function CoworkPanel({ id, tab }: { id: string; tab: string }) {
  const detail = useRpc('cowork.get', { id })
  const models = useRpc('models.list', {})
  const messages = useRpc('thread.messages', { id, kind: 'cowork', limit: 200 })
  const steps: RemoteToolStep[] = (messages.data?.messages ?? []).flatMap((m) => m.tools ?? [])
  const d = detail.data
  let body: ReactNode
  switch (tab) {
    case 'timeline':
      body = steps.length ? (
        <div className="tl" style={{ marginLeft: 4 }}>
          {steps.map((s) => (
            <div key={s.id} className="step" data-tool-kind={s.kind}>
              <div className="th" style={{ cursor: 'default' }}>
                <span className="tn">
                  {s.status === 'failed' ? `${s.name} failed` : s.status === 'awaiting' ? `Awaiting approval: ${s.name}` : s.name}
                </span>
                {s.arg && <span className="arg">{s.arg}</span>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty>No tool calls yet.</Empty>
      )
      break
    case 'progress':
      body = d && d.todos.length ? <ProgressCard detail={d} /> : <Empty>No plan yet. It appears when Flint writes a todo list.</Empty>
      break
    case 'details':
      body = d ? (
        <>
          <div className="card2">
            <h4>
              <I n="info" />
              Session details
            </h4>
            <Kv k="Folder" v={d.group ?? 'None'} />
            <Kv k="Mode" v={modeLabel(d.mode)?.label ?? d.mode} />
            <Kv k="Changes go to" v={accessLabel(d.access)?.label ?? d.access} />
            <Kv
              k="Model"
              v={d.model ? (models.data?.models.find((m) => m.id === d.model?.id)?.name ?? d.model.id) : 'Not chosen yet'}
            />
            <Kv k="Tool calls" v={String(steps.length)} />
          </div>
          {d.usage && (
            <div className="card2">
              <h4>
                <I n="gauge" />
                Usage
              </h4>
              <Kv k="Last run" v={`${compact(d.usage.inputTokens + d.usage.outputTokens)} tokens`} />
              <Kv k="Input" v={d.usage.inputTokens.toLocaleString()} />
              <Kv k="Output" v={d.usage.outputTokens.toLocaleString()} />
            </div>
          )}
        </>
      ) : (
        <Empty>Loading…</Empty>
      )
      break
    case 'changes':
      body = <Soon what="Changes and diffs" />
      break
    case 'activity':
      body = <Soon what="Subagents and background commands" />
      break
    case 'code':
      body = <Soon what="Files and code" />
      break
    default:
      body = <Soon what="Previews" />
  }
  return (
    <>
      <Header title="Output" />
      <Tabs tabs={COWORK_TABS} current={tab} />
      <div className="rbody">{body}</div>
    </>
  )
}

// ---------------------------------------------------------------------------

function ChatPanel({ tab }: { tab: string }) {
  const model = useApp((s) => s.composer.model)
  return (
    <>
      <Header title="This chat" />
      <Tabs
        tabs={[
          ['using', 'eye', 'What Flint is using'],
          ['usage', 'gauge', 'Usage'],
        ]}
        current={tab}
      />
      <div className="rbody">
        {tab === 'using' ? (
          <>
            <div className="card2">
              <h4>
                <I n="cube" />
                Model
              </h4>
              {model ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Avatar id={model.id} name={model.name} provider={model.provider} size={28} />
                  <span style={{ flex: 1 }}>
                    <b>{model.name}</b>
                    <br />
                    <small className="muted">{model.provider}</small>
                  </span>
                </div>
              ) : (
                <small className="muted">The chat's model is shown on the computer.</small>
              )}
            </div>
            <Soon what="Instructions, memory and tools for this chat" />
          </>
        ) : (
          <Soon what="Context and speed figures" />
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------

function RoomPanel({ id, tab }: { id: string; tab: string }) {
  const { data: room } = useRpc('rooms.get', { id })
  let body: ReactNode = <Empty>Loading…</Empty>
  if (room) {
    const next = room.participants.find((p) => p.id === room.nextSpeakerId) ?? room.participants[0]
    const order = next ? [...room.participants.slice(room.participants.indexOf(next)), ...room.participants.slice(0, room.participants.indexOf(next))] : []
    if (tab === 'participants') {
      body = (
        <>
          <div className="card2">
            <h4>
              <I n="users" />
              Participants · {room.participants.length}
            </h4>
            {room.participants.map((p) => (
              <div key={p.id} className="part" role="button" style={{ cursor: 'pointer' }} onClick={() => openSheet('reason', { for: 'room', id: room.id, participant: p.id })}>
                <Avatar id={p.model} provider={p.provider} name={p.name} size={28} />
                <span className="tx">
                  <b style={{ color: speakerColor(room, p.id) }}>{p.name}</b>
                  <small>
                    {p.role} · {p.model}
                  </small>
                </span>
                <span className={`bdg${p.toolAccess === 'edit' ? ' warn' : ''}`} style={p.toolAccess === 'read' ? { color: 'var(--info)' } : undefined}>
                  {p.toolAccess === 'edit' ? 'Read & edit' : p.toolAccess === 'read' ? 'Read-only' : 'No tools'}
                </span>
              </div>
            ))}
          </div>
          <div className="card2">
            <h4>Moderator</h4>
            <div className="kv">
              <span>Use a moderator</span>
              <Sw on={room.moderator.enabled} />
            </div>
            <small className="muted">The moderator never has tools.</small>
          </div>
        </>
      )
    } else if (tab === 'rsettings') {
      const l = room.limits
      body = (
        <div className="card2">
          <h4>
            <I n="settings" />
            Room settings
            {room.status === 'running' && (
              <span className="chip" style={{ marginLeft: 'auto' }}>
                <I n="lock" size={11} />
                Locked
              </span>
            )}
          </h4>
          {room.status === 'running' && <small className="muted">Pause the room to change settings.</small>}
          <Kv k="Speaking mode" v={room.mode === 'round-robin' ? 'Round-robin' : room.mode === 'user-selected' ? 'You choose' : 'Moderator chooses'} />
          <Kv k="Working folder" v={room.folder?.split(/[\\/]/).pop() ?? 'None'} />
          <Kv k="Rounds" v={l.maxRounds} />
          <Kv k="Turns" v={l.maxTurns} />
          <Kv k="Total tokens" v={compact(l.maxTotalTokens)} />
          <Kv k="Tokens per reply" v={l.maxOutputTokensPerTurn.toLocaleString()} />
          <Kv k="Cost limit (USD)" v={l.maxCostUsd === null ? 'None' : `$${l.maxCostUsd.toFixed(2)}`} />
          <Kv k="Running time" v={`${Math.round(l.maxDurationMs / 60000)} min`} />
        </div>
      )
    } else {
      body = (
        <>
          <div className="card2">
            {next && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <Avatar id={next.model} provider={next.provider} name={next.name} size={32} />
                <span style={{ flex: 1 }}>
                  <b>{room.status === 'running' ? `${next.name} is speaking` : `${next.name} speaks next`}</b>
                  <br />
                  <small className="muted">
                    {next.role} · {next.model}
                  </small>
                </span>
                {room.status === 'running' && (
                  <span className="eq">
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </div>
            )}
            <div className="kv">
              <span>
                Round <b style={{ color: 'var(--foreground)' }}>{room.usage.rounds}</b> of {room.limits.maxRounds}
              </span>
              <span>
                Turn <b style={{ color: 'var(--foreground)' }}>{room.usage.turns}</b> of {room.limits.maxTurns}
              </span>
            </div>
            <div className="meter">
              <i style={{ width: `${Math.min(100, (room.usage.turns / Math.max(1, room.limits.maxTurns)) * 100)}%` }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 6 }}>
              <button type="button" className="btn pri" onClick={() => notYet('Pausing a room')}>
                <I n="pause" />
                Pause
              </button>
              <button type="button" className="btn" onClick={() => notYet('Choosing the next speaker')}>
                Next
              </button>
              <button type="button" className="btn dan" onClick={() => void act('run.stop', { kind: 'room', id: room.id }, 'Stopped.')}>
                Stop
              </button>
            </div>
            {order.length > 1 && (
              <>
                <div className="lbl">Up next</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {order.map((p, i) => (
                    <span key={p.id} style={{ display: 'contents' }}>
                      {i > 0 && '›'}
                      <span className="chip" style={i === 0 ? { borderColor: 'var(--foreground)' } : undefined}>
                        <Avatar id={p.model} provider={p.provider} name={p.name} size={14} />
                        {p.name}
                      </span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="card2">
            <h4>
              <I n="sparkles" />
              Steer the discussion
            </h4>
            <div className="steer">
              {(
                [
                  ['vote', 'Call vote', 'Everyone agrees, disagrees or abstains'],
                  ['flag', 'Final positions', 'Each participant states where they stand'],
                  ['file', 'Synthesize', 'Summary of the outcome, with dissent'],
                  ['x', 'Cancel turn', 'Stop only the reply in progress'],
                ] as [IconId, string, string][]
              ).map(([icon, t, s]) => (
                <button key={t} type="button" onClick={() => notYet(t)}>
                  <b>
                    <I n={icon} size={14} /> {t}
                  </b>
                  <small>{s}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="card2">
            <h4>
              <I n="gauge" />
              Usage
            </h4>
            <Kv k="Tokens" v={`${compact(room.usage.tokens)} / ${compact(room.limits.maxTotalTokens)}`} />
            <Kv k="Time" v={`${duration(room.usage.activeMs)} / ${duration(room.limits.maxDurationMs)}`} />
            {room.usage.costUsd !== null && <Kv k="Cost" v={`$${room.usage.costUsd.toFixed(2)}`} />}
          </div>
        </>
      )
    }
  }
  return (
    <>
      <Header title="Room" />
      <Tabs
        tabs={[
          ['discussion', 'rooms', 'Discussion'],
          ['participants', 'users', 'Participants'],
          ['rsettings', 'settings', 'Settings'],
        ]}
        current={tab}
      />
      <div className="rbody">{body}</div>
    </>
  )
}

export function RightPanel() {
  const route = useApp((s) => s.route)
  const tab = useApp((s) => s.rightTab)
  if (route.name === 'cowork') {
    return <CoworkPanel id={route.id} tab={tab && COWORK_TABS.some((t) => t[0] === tab) ? tab : 'details'} />
  }
  if (route.name === 'room') {
    return <RoomPanel id={route.id} tab={tab === 'participants' || tab === 'rsettings' ? tab : 'discussion'} />
  }
  if (route.name === 'chat') return <ChatPanel tab={tab === 'usage' ? 'usage' : 'using'} />
  return null
}
