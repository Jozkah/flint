// The desktop's side panel and inspector, as a drawer from the right.
import type { ReactNode } from 'react'
import type { CoworkDetail, RemoteToolStep } from '@/lib/remote/protocol'
import { Avatar, Empty, Kv } from '../ui/bits'
import { compact, duration, speakerColor } from '../ui/format'
import { I, type IconId } from '../ui/icons'
import { act, app, client, closeAll, openSheet, toast, useApp } from '../state/app'
import { invalidate, useRpc } from '../state/rpc'
import { accessLabel, modeLabel } from './labels'
import { roomAct } from '../state/controls'
import { ActivityList, ChangesList } from '../ui/changes'

function Header({ title }: { title: string }) {
  return <><div className="dpad" /><div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px 8px 14px', gap: 6 }}><b style={{ flex: 1, fontSize: 15 }}>{title}</b><button type="button" className="ib" onClick={closeAll} aria-label="Close"><I n="x" /></button></div></>
}

function Tabs({ tabs, current }: { tabs: [string, IconId, string][]; current: string }) {
  return <div className="rtabs" role="tablist">{tabs.map(([id, icon, label]) => <button key={id} type="button" role="tab" aria-selected={current === id} onClick={() => app.set({ rightTab: id })}><I n={icon} />{label}</button>)}</div>
}

function Soon({ what }: { what: string }) {
  return <Empty icon={<I n="monitor" size={18} />}>{what} are shown on the computer for now.</Empty>
}

const COWORK_TABS: [string, IconId, string][] = [
  ['changes', 'plus', 'Changes'], ['activity', 'activity', 'Activity'], ['timeline', 'timeline', 'Timeline'], ['progress', 'todo', 'Progress'], ['code', 'code', 'Code'], ['preview', 'eye', 'Preview'], ['details', 'info', 'Details'],
]

export function ProgressCard({ detail }: { detail: CoworkDetail }) {
  const done = detail.todos.filter((t) => t.status === 'completed').length
  return <div className="card2"><h4><I n="todo" />Progress<span className="muted" style={{ marginLeft: 'auto', fontWeight: 400, fontSize: 12 }}>{done} of {detail.todos.length} done</span></h4>{detail.todos.map((t, i) => <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>{t.status === 'completed' ? <I n="check" style={{ color: 'var(--success)' }} /> : t.status === 'in_progress' ? <I n="loader" spin style={{ color: 'var(--warning)' }} /> : <span style={{ width: 16, height: 16, borderRadius: '50%', border: '1.5px solid var(--border-strong)', flex: 'none' }} />}<span style={t.status === 'completed' ? { color: 'var(--muted-foreground)', textDecoration: 'line-through' } : undefined}>{t.text}</span></div>)}</div>
}

function CoworkPanel({ id, tab }: { id: string; tab: string }) {
  const detail = useRpc('cowork.get', { id })
  const models = useRpc('models.list', {})
  const messages = useRpc('thread.messages', { id, kind: 'cowork', limit: 200 })
  const changes = useRpc('cowork.changes', { id }, tab === 'changes')
  const activity = useRpc('cowork.activity', { id }, tab === 'activity')
  const steps: RemoteToolStep[] = (messages.data?.messages ?? []).flatMap((m) => m.tools ?? [])
  const d = detail.data
  let body: ReactNode
  if (tab === 'timeline') body = steps.length ? <div className="tl" style={{ marginLeft: 4 }}>{steps.map((s) => <div key={s.id} className="step" data-tool-kind={s.kind}><div className="th" style={{ cursor: 'default' }}><span className="tn">{s.status === 'failed' ? `${s.name} failed` : s.status === 'awaiting' ? `Awaiting approval: ${s.name}` : s.name}</span>{s.arg && <span className="arg">{s.arg}</span>}</div></div>)}</div> : <Empty>No tool calls yet.</Empty>
  else if (tab === 'progress') body = d && d.todos.length ? <ProgressCard detail={d} /> : <Empty>No plan yet. It appears when Flint writes a todo list.</Empty>
  else if (tab === 'details') body = d ? <><div className="card2"><h4><I n="info" />Session details</h4><Kv k="Folder" v={d.group ?? 'None'} /><Kv k="Mode" v={modeLabel(d.mode)?.label ?? d.mode} /><Kv k="Changes go to" v={accessLabel(d.access)?.label ?? d.access} /><Kv k="Model" v={d.model ? (models.data?.models.find((m) => m.id === d.model?.id)?.name ?? d.model.id) : 'Not chosen yet'} /><Kv k="Tool calls" v={String(steps.length)} /></div>{d.usage && <div className="card2"><h4><I n="gauge" />Usage</h4><Kv k="Last run" v={`${compact(d.usage.inputTokens + d.usage.outputTokens)} tokens`} /><Kv k="Input" v={d.usage.inputTokens.toLocaleString()} /><Kv k="Output" v={d.usage.outputTokens.toLocaleString()} /></div>}</> : <Empty>Loading…</Empty>
  else if (tab === 'changes') body = changes.data ? <ChangesList c={changes.data} /> : changes.error ? <Empty>{changes.error.message}</Empty> : <Empty>Loading…</Empty>
  else if (tab === 'activity') body = activity.data ? <ActivityList a={activity.data} /> : activity.error ? <Empty>{activity.error.message}</Empty> : <Empty>Loading…</Empty>
  else if (tab === 'code') body = <Soon what="Files and code" />
  else body = <Soon what="Previews" />
  return <><Header title="Output" /><Tabs tabs={COWORK_TABS} current={tab} /><div className="rbody">{body}</div></>
}

function ChatPanel({ tab }: { tab: string }) {
  return <><Header title="This chat" /><Tabs tabs={[[ 'using', 'eye', 'What Flint is using' ], [ 'usage', 'gauge', 'Usage' ]]} current={tab} /><div className="rbody"><Soon what={tab === 'using' ? 'The chat model, instructions, memory and tools' : 'Context and speed figures'} /></div></>
}

async function updateRoom(id: string, patch: Record<string, unknown>, done = 'Room updated.') {
  try {
    await client().rpc('settings.set', { mobileOp: 'room.update', id, patch } as never)
    invalidate(['rooms.get', 'sessions.list'])
    toast(done)
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Could not update the Room')
  }
}

function RoomPanel({ id, tab }: { id: string; tab: string }) {
  const { data: room } = useRpc('rooms.get', { id })
  const models = useRpc('models.list', {})
  let body: ReactNode = <Empty>Loading…</Empty>
  if (room) {
    const next = room.participants.find((p) => p.id === room.nextSpeakerId) ?? room.participants[0]
    const order = next ? [...room.participants.slice(room.participants.indexOf(next)), ...room.participants.slice(0, room.participants.indexOf(next))] : []
    const locked = room.status === 'running'
    if (tab === 'participants') {
      body = <>
        <div className="card2"><h4><I n="users" />Participants · {room.participants.length}</h4>{room.participants.map((p) => {
          const reasoning = (p as unknown as { reasoning?: { mode?: string; level?: string } }).reasoning
          return <div key={p.id} className="part" style={{ alignItems: 'flex-start' }}><Avatar id={p.model} provider={p.provider} name={p.name} size={28} /><span className="tx" style={{ minWidth: 0 }}><b style={{ color: speakerColor(room, p.id) }}>{p.name}</b><small>{p.role}</small><select aria-label={`${p.name} model`} value={`${p.provider}::${p.model}`} disabled={locked} onChange={(e) => { const [provider, model] = e.target.value.split('::'); void updateRoom(room.id, { participants: [{ id: p.id, model: { provider, id: model } }] }, `${p.name}'s model updated.`) }}>{models.data?.models.map((m) => <option key={`${m.provider}/${m.id}`} value={`${m.provider}::${m.id}`}>{m.name}</option>)}</select><div style={{ display: 'flex', gap: 5, marginTop: 5 }}>{(['auto','on','off'] as const).map((mode) => <button key={mode} type="button" className={`chip${(reasoning?.mode ?? 'auto') === mode ? ' on' : ''}`} disabled={locked} onClick={() => void updateRoom(room.id, { participants: [{ id: p.id, reasoning: { ...(reasoning ?? {}), mode } }] }, `${p.name}: reasoning ${mode}.`)}>{mode === 'auto' ? 'Auto' : mode === 'on' ? 'Reason' : 'Off'}</button>)}</div><select aria-label={`${p.name} reasoning level`} value={reasoning?.level ?? 'unlimited'} disabled={locked} onChange={(e) => void updateRoom(room.id, { participants: [{ id: p.id, reasoning: { ...(reasoning ?? {}), level: e.target.value } }] }, `${p.name}'s reasoning level updated.`)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option><option value="unlimited">Unlimited/default</option></select></span></div>
        })}</div>
        <div className="card2"><h4>Moderator</h4><button type="button" className={`row${room.moderator.enabled ? ' on' : ''}`} disabled={locked} onClick={() => void updateRoom(room.id, { moderator: { enabled: !room.moderator.enabled } }, room.moderator.enabled ? 'Moderator disabled.' : 'Moderator enabled.')}><span className="tx"><b>Use a moderator</b><small>The moderator never has tools.</small></span><span>{room.moderator.enabled ? 'On' : 'Off'}</span></button>{room.moderator.enabled && <select aria-label="Moderator model" value={room.moderator.model ? `${room.moderator.model}` : ''} disabled={locked} onChange={(e) => { const found = models.data?.models.find((m) => `${m.provider}::${m.id}` === e.target.value); if (found) void updateRoom(room.id, { moderator: { enabled: true, model: { provider: found.provider, id: found.id } } }, 'Moderator model updated.') }}><option value="">Choose model…</option>{models.data?.models.map((m) => <option key={`${m.provider}/${m.id}`} value={`${m.provider}::${m.id}`}>{m.name}</option>)}</select>}</div>
      </>
    } else if (tab === 'rsettings') {
      const l = room.limits
      const num = (label: string, value: number, key: string, min: number, max: number) => <label className="field">{label}<input type="number" min={min} max={max} value={value} disabled={locked} onChange={(e) => void updateRoom(room.id, { limits: { [key]: Number(e.target.value) } }, `${label} updated.`)} /></label>
      body = <div className="card2"><h4><I n="settings" />Room settings{locked && <span className="chip" style={{ marginLeft: 'auto' }}><I n="lock" size={11} />Locked</span>}</h4>{locked && <small className="muted">Pause the room to change settings.</small>}<label className="field">Speaking mode<select value={room.mode} disabled={locked} onChange={(e) => void updateRoom(room.id, { mode: e.target.value }, 'Speaking mode updated.')}><option value="round-robin">Round-robin</option><option value="user-selected">You choose</option><option value="moderator-selected">Moderator chooses</option></select></label>{num('Rounds', l.maxRounds, 'maxRounds', 1, 50)}{num('Turns', l.maxTurns, 'maxTurns', 1, 200)}{num('Total tokens', l.maxTotalTokens, 'maxTotalTokens', 1000, 2000000)}{num('Tokens per reply', l.maxOutputTokensPerTurn, 'maxOutputTokensPerTurn', 64, 8192)}{num('Running time (minutes)', Math.round(l.maxDurationMs / 60000), 'maxDurationMs', 1, 240)}<small className="muted">Working folder and write permissions remain desktop-only because they grant filesystem access.</small></div>
    } else {
      body = <><div className="card2">{next && <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Avatar id={next.model} provider={next.provider} name={next.name} size={32} /><span style={{ flex: 1 }}><b>{room.status === 'running' ? `${next.name} is speaking` : `${next.name} speaks next`}</b><br /><small className="muted">{next.role} · {next.model}</small></span>{room.status === 'running' && <span className="eq"><i /><i /><i /><i /></span>}</div>}<div className="kv"><span>Round <b style={{ color: 'var(--foreground)' }}>{room.usage.rounds}</b> of {room.limits.maxRounds}</span><span>Turn <b style={{ color: 'var(--foreground)' }}>{room.usage.turns}</b> of {room.limits.maxTurns}</span></div><div className="meter"><i style={{ width: `${Math.min(100, (room.usage.turns / Math.max(1, room.limits.maxTurns)) * 100)}%` }} /></div><div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 6 }}>{room.status === 'running' ? <button type="button" className="btn pri" onClick={() => roomAct({ id: room.id }, 'pause', 'Paused.')}><I n="pause" />Pause</button> : <button type="button" className="btn pri" onClick={() => roomAct({ id: room.id }, room.roomStatus === 'draft' ? 'start' : 'resume', 'Resumed.')}><I n="play" />{room.roomStatus === 'draft' ? 'Start' : 'Resume'}</button>}<button type="button" className="btn" disabled={order.length < 2} onClick={() => { const who = order[1]; if (who) void act('room.control', { id: room.id, action: 'next', participantId: who.id }, `${who.name} speaks next`) }}>Next</button><button type="button" className="btn dan" onClick={() => roomAct({ id: room.id }, 'stop', 'Stopped.')} >Stop</button></div>{order.length > 1 && <><div className="lbl">Up next</div><div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{order.map((p, i) => <span key={p.id} style={{ display: 'contents' }}>{i > 0 && '›'}<span className="chip" style={i === 0 ? { borderColor: 'var(--foreground)' } : undefined}><Avatar id={p.model} provider={p.provider} name={p.name} size={14} />{p.name}</span></span>)}</div></>}</div><div className="card2"><h4><I n="sparkles" />Steer the discussion</h4><div className="steer">{([['vote','Call vote','Everyone agrees, disagrees or abstains',() => openSheet('vote',{ id: room.id })],['flag','Final positions','Each participant states where they stand',() => roomAct({ id: room.id },'final','Asked for final positions.')],['file','Synthesize','Summary of the outcome, with dissent',() => roomAct({ id: room.id },'synthesize','Asked for a synthesis.')],['x','Cancel turn','Stop only the reply in progress',() => roomAct({ id: room.id },'cancel','Turn cancelled.')]] as [IconId,string,string,() => void][]).map(([icon,t,s,run]) => <button key={t} type="button" onClick={run}><b><I n={icon} size={14} /> {t}</b><small>{s}</small></button>)}</div></div><div className="card2"><h4><I n="gauge" />Usage</h4><Kv k="Tokens" v={`${compact(room.usage.tokens)} / ${compact(room.limits.maxTotalTokens)}`} /><Kv k="Time" v={`${duration(room.usage.activeMs)} / ${duration(room.limits.maxDurationMs)}`} />{room.usage.costUsd !== null && <Kv k="Cost" v={`$${room.usage.costUsd.toFixed(2)}`} />}</div></>
    }
  }
  return <><Header title="Room" /><Tabs tabs={[[ 'discussion', 'rooms', 'Discussion' ], [ 'participants', 'users', 'Participants' ], [ 'rsettings', 'settings', 'Settings' ]]} current={tab} /><div className="rbody">{body}</div></>
}

export function RightPanel() {
  const route = useApp((s) => s.route)
  const tab = useApp((s) => s.rightTab)
  if (route.name === 'cowork') return <CoworkPanel id={route.id} tab={tab && COWORK_TABS.some((t) => t[0] === tab) ? tab : 'details'} />
  if (route.name === 'room') return <RoomPanel id={route.id} tab={tab === 'participants' || tab === 'rsettings' ? tab : 'discussion'} />
  if (route.name === 'chat') return <ChatPanel tab={tab === 'usage' ? 'usage' : 'using'} />
  return null
}
