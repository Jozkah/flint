import type { ReactNode } from 'react'
import type { CoworkDetail, RemoteToolStep, RoomUpdateParams } from '@/lib/remote/protocol'
import { Avatar, Empty, Kv } from '../ui/bits'
import { compact, duration, speakerColor } from '../ui/format'
import { I, type IconId } from '../ui/icons'
import { Tx } from '../ui/trans'
import { act, app, client, closeAll, openSheet, toast, useApp } from '../state/app'
import { invalidate, useRpc } from '../state/rpc'
import { accessLabel, modeLabel } from './labels'
import { roomAct } from '../state/controls'
import { ActivityList, ChangesList } from '../ui/changes'
import { ChatUsage, ChatUsing, CodeTab, PreviewTab } from './panels'
import { ScrubField } from '../ui/scrub-field'
import { t } from '../i18n'

function Header({ title }: { title: string }) {
  return <><div className="dpad" /><div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px 8px 14px', gap: 6 }}><b style={{ flex: 1, fontSize: 15 }}>{title}</b><button type="button" className="ib" onClick={closeAll} aria-label={t('rightpanel.close')}><I n="x" /></button></div></>
}

function Tabs({ tabs, current }: { tabs: [string, IconId, string][]; current: string }) {
  return <div className="rtabs" role="tablist">{tabs.map(([id, icon, label]) => <button key={id} type="button" role="tab" aria-selected={current === id} onClick={() => app.set({ rightTab: id })}><I n={icon} />{label}</button>)}</div>
}


const COWORK_TABS: [string, IconId, string][] = [
  ['changes', 'plus', t('cowork.changes')], ['activity', 'activity', t('cowork.activity')], ['timeline', 'timeline', t('rightpanel.timeline')], ['progress', 'todo', t('cowork.progress')], ['code', 'code', t('rightpanel.code')], ['preview', 'eye', t('rightpanel.preview')], ['details', 'info', t('rightpanel.details')],
]

export function ProgressCard({ detail }: { detail: CoworkDetail }) {
  const done = detail.todos.filter((todo) => todo.status === 'completed').length
  return <div className="card2"><h4><I n="todo" />{t('cowork.progress')}<span className="muted" style={{ marginLeft: 'auto', fontWeight: 400, fontSize: 12 }}>{t('cowork.progressCount', { done, total: detail.todos.length })}</span></h4>{detail.todos.map((todo, i) => <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>{todo.status === 'completed' ? <I n="check" style={{ color: 'var(--success)' }} /> : todo.status === 'in_progress' ? <I n="loader" spin style={{ color: 'var(--warning)' }} /> : <span style={{ width: 16, height: 16, borderRadius: '50%', border: '1.5px solid var(--border-strong)', flex: 'none' }} />}<span style={todo.status === 'completed' ? { color: 'var(--muted-foreground)', textDecoration: 'line-through' } : undefined}>{todo.text}</span></div>)}</div>
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
  if (tab === 'timeline') body = steps.length ? <div className="tl" style={{ marginLeft: 4 }}>{steps.map((s) => <div key={s.id} className="step" data-tool-kind={s.kind}><div className="th" style={{ cursor: 'default' }}><span className="tn">{s.status === 'failed' ? t('format.failed', { name: s.name }) : s.status === 'awaiting' ? t('format.awaitingApproval', { name: s.name }) : s.name}</span>{s.arg && <span className="arg">{s.arg}</span>}</div></div>)}</div> : <Empty>{t('rightpanel.noToolCalls')}</Empty>
  else if (tab === 'progress') body = d && d.todos.length ? <ProgressCard detail={d} /> : <Empty>{t('rightpanel.noPlan')}</Empty>
  else if (tab === 'details') body = d ? <><div className="card2"><h4><I n="info" />{t('rightpanel.sessionDetails')}</h4><Kv k={t('home.folder')} v={d.group ?? t('rightpanel.none')} /><Kv k={t('rightpanel.mode')} v={modeLabel(d.mode)?.label ?? d.mode} /><Kv k={t('rightpanel.changesGoTo')} v={accessLabel(d.access)?.label ?? d.access} /><Kv k={t('chat.model')} v={d.model ? (models.data?.models.find((m) => m.id === d.model?.id)?.name ?? d.model.id) : t('rightpanel.notChosen')} /><Kv k={t('rightpanel.toolCalls')} v={String(steps.length)} /></div>{d.usage && <div className="card2"><h4><I n="gauge" />{t('rightpanel.usage')}</h4><Kv k={t('rightpanel.lastRun')} v={t('reply.tokens', { count: compact(d.usage.inputTokens + d.usage.outputTokens) })} /><Kv k={t('rightpanel.input')} v={d.usage.inputTokens.toLocaleString()} /><Kv k={t('rightpanel.output')} v={d.usage.outputTokens.toLocaleString()} /></div>}</> : <Empty>{t('common.loading')}</Empty>
  else if (tab === 'changes') body = changes.data ? <ChangesList c={changes.data} /> : changes.error ? <Empty>{changes.error.message}</Empty> : <Empty>{t('common.loading')}</Empty>
  else if (tab === 'activity') body = activity.data ? <ActivityList a={activity.data} /> : activity.error ? <Empty>{activity.error.message}</Empty> : <Empty>{t('common.loading')}</Empty>
  else if (tab === 'code') body = <CodeTab id={id} />
  else body = <PreviewTab id={id} />
  return <><Header title={t('rightpanel.output')} /><Tabs tabs={COWORK_TABS} current={tab} /><div className="rbody">{body}</div></>
}

function ChatPanel({ id, tab }: { id: string; tab: string }) {
  return <><Header title={t('rightpanel.thisChat')} /><Tabs tabs={[[ 'using', 'eye', t('rightpanel.using') ], [ 'usage', 'gauge', t('rightpanel.context') ]]} current={tab} /><div className="rbody">{tab === 'usage' ? <ChatUsage id={id} /> : <ChatUsing id={id} />}</div></>
}

async function updateRoom(id: string, patch: RoomUpdateParams['patch'], done = t('rightpanel.roomUpdated')) {
  try {
    await client().rpc('room.update', { id, patch })
    invalidate(['rooms.get', 'sessions.list'])
    toast(done)
  } catch (e) {
    toast(e instanceof Error ? e.message : t('rightpanel.roomUpdateFailed'))
  }
}

function RoomPanel({ id, tab }: { id: string; tab: string }) {
  const { data: room } = useRpc('rooms.get', { id })
  const models = useRpc('models.list', {})
  let body: ReactNode = <Empty>{t('common.loading')}</Empty>
  if (room) {
    const next = room.participants.find((p) => p.id === room.nextSpeakerId) ?? room.participants[0]
    const order = next ? [...room.participants.slice(room.participants.indexOf(next)), ...room.participants.slice(0, room.participants.indexOf(next))] : []
    const locked = room.status === 'running'
    if (tab === 'participants') {
      const moderatorValue = room.moderator.model
        ? `${room.moderator.provider ?? models.data?.models.find((candidate) => candidate.id === room.moderator.model)?.provider ?? ''}::${room.moderator.model}`
        : ''
      body = <>
        <div className="card2"><h4><I n="users" />{t('rightpanel.participants', { count: room.participants.length })}</h4>{room.participants.map((p) => <div key={p.id} className="part" style={{ alignItems: 'flex-start' }}><Avatar id={p.model} provider={p.provider} name={p.name} size={28} /><span className="tx" style={{ minWidth: 0 }}><b style={{ color: speakerColor(room, p.id) }}>{p.name}</b><small>{p.role}</small><select aria-label={t('rightpanel.participantModel', { name: p.name })} value={`${p.provider}::${p.model}`} disabled={locked} onChange={(e) => { const [provider, model] = e.target.value.split('::'); void updateRoom(room.id, { participants: [{ id: p.id, model: { provider, id: model } }] }, t('rightpanel.participantModelUpdated', { name: p.name })) }}>{models.data?.models.map((m) => <option key={`${m.provider}/${m.id}`} value={`${m.provider}::${m.id}`}>{m.name}</option>)}</select><button type="button" className="btn sm" disabled={locked} onClick={() => openSheet('reason', { for: 'room', id: room.id, participant: p.id, reason: p.reasoning?.mode ?? 'auto' })}>{t('rightpanel.reasoning', { mode: p.reasoning?.mode ?? 'auto' })}</button></span></div>)}</div>
        <div className="card2"><h4>{t('rightpanel.moderator')}</h4><button type="button" className={`row${room.moderator.enabled ? ' on' : ''}`} disabled={locked} onClick={() => void updateRoom(room.id, { moderator: { enabled: !room.moderator.enabled } }, room.moderator.enabled ? t('rightpanel.moderatorDisabled') : t('rightpanel.moderatorEnabled'))}><span className="tx"><b>{t('rightpanel.useModerator')}</b><small>{t('rightpanel.moderatorNoTools')}</small></span><span>{room.moderator.enabled ? t('common.on') : t('common.off')}</span></button>{room.moderator.enabled && <select aria-label={t('rightpanel.moderatorModel')} value={moderatorValue} disabled={locked} onChange={(e) => { const [provider, model] = e.target.value.split('::'); if (provider && model) void updateRoom(room.id, { moderator: { enabled: true, model: { provider, id: model } } }, t('rightpanel.moderatorModelUpdated')) }}><option value="">{t('rightpanel.chooseModel')}</option>{models.data?.models.map((m) => <option key={`${m.provider}/${m.id}`} value={`${m.provider}::${m.id}`}>{m.name}</option>)}</select>}</div>
      </>
    } else if (tab === 'rsettings') {
      const l = room.limits
      const numberField = (
        label: string,
        value: number,
        key: keyof typeof l,
        min: number,
        max: number,
        convert: (v: number) => number = (v) => v
      ) => (
        <ScrubField
          label={label}
          value={value}
          min={min}
          max={max}
          disabled={locked}
          onCommit={(n) =>
            void updateRoom(
              room.id,
              { limits: { [key]: convert(n) } },
              `${label} updated.`
            )
          }
        />
      )
      body = (
        <div className="card2">
          <h4>
            <I n="settings" />
            Room settings
            {locked && (
              <span className="chip" style={{ marginLeft: 'auto' }}>
                <I n="lock" size={11} />
                Locked
              </span>
            )}
          </h4>
          {locked && (
            <small className="muted">Pause the room to change settings.</small>
          )}
          <label className="field">
            Speaking mode
            <select
              value={room.mode}
              disabled={locked}
              onChange={(e) =>
                void updateRoom(
                  room.id,
                  { mode: e.target.value as RoomUpdateParams['patch']['mode'] },
                  'Speaking mode updated.'
                )
              }
            >
              <option value="round-robin">Round-robin</option>
              <option value="user-selected">You choose</option>
              <option value="moderator-selected">Moderator chooses</option>
            </select>
          </label>
          {numberField('Rounds', l.maxRounds, 'maxRounds', 1, 50)}
          {numberField('Turns', l.maxTurns, 'maxTurns', 1, 200)}
          {numberField(
            'Total tokens',
            l.maxTotalTokens,
            'maxTotalTokens',
            1000,
            2000000
          )}
          {numberField(
            'Tokens per reply',
            l.maxOutputTokensPerTurn,
            'maxOutputTokensPerTurn',
            64,
            8192
          )}
          {numberField(
            'Running time (minutes)',
            Math.round(l.maxDurationMs / 60000),
            'maxDurationMs',
            1,
            240,
            (minutes) => Math.round(minutes * 60000)
          )}
          <small className="muted">
            Working folder and write permissions remain desktop-only because
            they grant filesystem access.
          </small>
        </div>
      )
    } else {
      body = <><div className="card2">{next && <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Avatar id={next.model} provider={next.provider} name={next.name} size={32} /><span style={{ flex: 1 }}><b>{room.status === 'running' ? t('room.speaking', { name: next.name }) : t('rightpanel.speaksNext', { name: next.name })}</b><br /><small className="muted">{next.role} · {next.model}</small></span></div>}<div className="kv"><span><Tx k="rightpanel.roundOf" parts={{ round: <b>{room.usage.rounds}</b>, max: room.limits.maxRounds }} /></span><span><Tx k="rooms.turnOf" parts={{ turn: <b>{room.usage.turns}</b>, max: room.limits.maxTurns }} /></span></div><div className="meter"><i style={{ width: `${Math.min(100, (room.usage.turns / Math.max(1, room.limits.maxTurns)) * 100)}%` }} /></div><div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 6 }}>{room.status === 'running' ? <button type="button" className="btn pri" onClick={() => roomAct({ id: room.id }, 'pause', t('rightpanel.paused'))}><I n="pause" />{t('rightpanel.pause')}</button> : <button type="button" className="btn pri" onClick={() => roomAct({ id: room.id }, room.roomStatus === 'draft' ? 'start' : 'resume', room.roomStatus === 'draft' ? t('rightpanel.started') : t('rightpanel.resumed'))}><I n="play" />{room.roomStatus === 'draft' ? t('rightpanel.start') : t('rightpanel.resume')}</button>}<button type="button" className="btn" disabled={order.length < 2} onClick={() => { const who = order[1]; if (who) void act('room.control', { id: room.id, action: 'next', participantId: who.id }, t('rightpanel.speaksNext', { name: who.name })) }}>{t('rightpanel.next')}</button><button type="button" className="btn dan" onClick={() => roomAct({ id: room.id }, 'stop', t('rightpanel.stopped'))} >{t('studio.stop')}</button></div></div><div className="card2"><h4><I n="sparkles" />{t('room.steer')}</h4><div className="steer"><button type="button" onClick={() => openSheet('vote', { id: room.id })}><b><I n="vote" size={14} /> {t('rightpanel.callVote')}</b><small>{t('rightpanel.voteHint')}</small></button><button type="button" onClick={() => roomAct({ id: room.id }, 'final', t('rightpanel.finalAsked'))}><b><I n="flag" size={14} /> {t('rightpanel.finalPositions')}</b></button><button type="button" onClick={() => roomAct({ id: room.id }, 'synthesize', t('rightpanel.synthesisAsked'))}><b><I n="file" size={14} /> {t('rightpanel.synthesize')}</b></button><button type="button" onClick={() => roomAct({ id: room.id }, 'cancel', t('rightpanel.turnCancelled'))}><b><I n="x" size={14} /> {t('rightpanel.cancelTurn')}</b></button></div></div><div className="card2"><h4><I n="gauge" />{t('rightpanel.usage')}</h4><Kv k={t('rightpanel.tokens')} v={`${compact(room.usage.tokens)} / ${compact(room.limits.maxTotalTokens)}`} /><Kv k={t('rightpanel.time')} v={`${duration(room.usage.activeMs)} / ${duration(room.limits.maxDurationMs)}`} />{room.usage.costUsd !== null && <Kv k={t('rightpanel.cost')} v={`$${room.usage.costUsd.toFixed(2)}`} />}</div></>
    }
  }
  return <><Header title={t('room.crumb')} /><Tabs tabs={[[ 'discussion', 'rooms', t('rightpanel.discussion') ], [ 'participants', 'users', t('rightpanel.participantsTab') ], [ 'rsettings', 'settings', t('settings.title') ]]} current={tab} /><div className="rbody">{body}</div></>
}

export function RightPanel() {
  const route = useApp((s) => s.route)
  const tab = useApp((s) => s.rightTab)
  if (route.name === 'cowork') return <CoworkPanel id={route.id} tab={tab && COWORK_TABS.some((entry) => entry[0] === tab) ? tab : 'details'} />
  if (route.name === 'room') return <RoomPanel id={route.id} tab={tab === 'participants' || tab === 'rsettings' ? tab : 'discussion'} />
  if (route.name === 'chat') return <ChatPanel id={route.id} tab={tab === 'usage' ? 'usage' : 'using'} />
  return null
}
