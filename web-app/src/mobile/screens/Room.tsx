import { useState } from 'react'
import type { RoomDetail } from '@/lib/remote/protocol'
import { TopThread } from '../shell/TopBar'
import { Composer } from '../shell/Composer'
import { ROOM_STATUS } from '../shell/labels'
import { I } from '../ui/icons'
import { Tx } from '../ui/trans'
import { Avatar, Empty, Loading } from '../ui/bits'
import { compact, duration, speakerColor } from '../ui/format'
import { Prose } from '../ui/messages'
import { openDrawer, openSheet, sendMessage } from '../state/app'
import { useRpc } from '../state/rpc'
import { pendingFor, useLive } from '../state/live'
import { PendingBubble, StreamingMessage } from '../ui/live'
import { useFollow, useStickToBottom } from '../ui/hooks'
import { t } from '../i18n'

function UsageStrip({ room }: { room: RoomDetail }) {
  const { usage: u, limits: l } = room
  return (
    <div className="usage">
      <span>
        <Tx k="room.usage.turns" parts={{ value: <b>{u.turns} / {l.maxTurns}</b> }} />
      </span>
      <span>
        <Tx k="room.usage.rounds" parts={{ value: <b>{u.rounds} / {l.maxRounds}</b> }} />
      </span>
      <span>
        <Tx k="room.usage.tokens" parts={{ value: <b>{compact(u.tokens)} / {compact(l.maxTotalTokens)}</b> }} />
      </span>
      {u.costUsd !== null && (
        <span>
          <Tx k="room.usage.cost" parts={{ value: <b>${u.costUsd.toFixed(2)}{l.maxCostUsd !== null ? ` / $${l.maxCostUsd.toFixed(2)}` : ''}</b> }} />
        </span>
      )}
      <span>
        <Tx k="room.usage.time" parts={{ value: <b>{duration(u.activeMs)} / {duration(l.maxDurationMs)}</b> }} />
      </span>
    </div>
  )
}

export default function Room({ id }: { id: string }) {
  const { data: room, error } = useRpc('rooms.get', { id })
  const msgs = useRpc('thread.messages', { id, kind: 'room', limit: 100 })
  const messages = msgs.data?.messages ?? []
  const stream = useLive((s) => s.streams[id])
  const pending = pendingFor(
    useLive((s) => s.pending),
    id,
    messages
  )
  useFollow('room', id)
  const streamShown = stream && !messages.some((m) => m.id === stream.messageId) ? stream : null
  const ref = useStickToBottom(messages.length + pending.length + (streamShown?.text.length ?? 0))
  const [to, setTo] = useState<string>('everyone')
  const running = room?.status === 'running'
  const next = room?.participants.find((p) => p.id === room.nextSpeakerId) ?? room?.participants[0]
  const byName = (name?: string) => room?.participants.find((p) => p.name === name)

  return (
    <>
      <TopThread
        crumb={
          <>
            {running ? <I n="loader" size={11} spin="slow" /> : room?.roomStatus === 'awaiting-user' ? <span className="sd wait" style={{ width: 6, height: 6 }} /> : null}
            {room ? t('room.crumbStatus', { status: ROOM_STATUS[room.roomStatus] ?? t('room.crumb') }) : t('room.crumb')}
          </>
        }
        title={room?.title || t('room.crumb')}
        menu={() => openSheet('roommenu', { id, title: room?.title })}
      />
      {room && <UsageStrip room={room} />}
      <div className="scroll" ref={ref} data-testid="room-scroll">
        {!room && !error && <Loading />}
        {error && !room && <Empty>{error.message}</Empty>}
        {room && next && (running || room.roomStatus === 'awaiting-user') && (
          <div className="stage">
            <Avatar id={next.model} provider={next.provider} name={next.name} size={32} />
            <span className="tx">
              <b>{running ? t('room.speaking', { name: next.name }) : t('room.waitingForYou')}</b>
              <small>
                {running
                  ? t('room.stageLine', { role: next.role, model: next.model, round: Math.max(1, room.round), max: room.limits.maxRounds })
                  : t('room.chooseNext')}
              </small>
            </span>
            {running && (
              <span className="eq">
                <i />
                <i />
                <i />
                <i />
              </span>
            )}
          </div>
        )}
        {room && room.objective && messages.length === 0 && (
          <div className="rm">
            <div className="who">
              <b>{t('room.objective')}</b>
            </div>
            {room.objective}
          </div>
        )}
        {msgs.data && messages.length === 0 && <Empty>{t('room.noOne')}</Empty>}
        {messages.map((m) => {
          const p = byName(m.author)
          const isUser = m.role === 'user'
          return (
            <div key={m.id} className="rm msg">
              <div className="who">
                {!isUser && p && <Avatar id={p.model} provider={p.provider} name={p.name} size={16} />}
                <b style={p && room ? { color: speakerColor(room, p.id) } : undefined}>{isUser ? t('room.you') : (m.author ?? t('room.moderator'))}</b>
                {!isUser && (m.authorRole || p) && (
                  <>
                    · {m.authorRole ?? p?.role}
                    {(m.authorModel ?? p?.model) && ` · ${m.authorModel ?? p?.model}`}
                  </>
                )}
              </div>
              <Prose text={m.text} />
            </div>
          )
        })}
        {pending.map((p) => (
          <PendingBubble key={p.clientId} p={p} />
        ))}
        {streamShown && <StreamingMessage s={streamShown} />}
      </div>
      <Composer
        placeholder={t('room.placeholder')}
        label={t('room.messageLabel')}
        top={
          <div className="to">
            <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
              {t('room.to')}
            </span>
            <button type="button" className="chip" aria-pressed={to === 'everyone'} onClick={() => setTo('everyone')}>
              <I n="at" size={12} />
              {t('room.everyone')}
            </button>
            {room?.participants.map((p) => (
              <button key={p.id} type="button" className="chip" aria-pressed={to === p.id} onClick={() => setTo(p.id)}>
                <Avatar id={p.model} provider={p.provider} name={p.name} size={14} />
                {p.name}
              </button>
            ))}
          </div>
        }
        extra={
          <>
            <button type="button" className="ib" aria-label={t('room.mention')} onClick={() => setTo('everyone')}>
              <I n="at" />
            </button>
            <button type="button" className="ib" onClick={() => openDrawer('right', 'discussion')} aria-label={t('room.steer')}>
              <I n="flag" />
            </button>
            <button type="button" className="ib" onClick={() => openDrawer('right', 'participants')} aria-label={t('room.reasoning')}>
              <I n="bulb" />
            </button>
          </>
        }
        onSend={async (text) => (await sendMessage('room.send', { id, text, to: to === 'everyone' ? null : to })) !== undefined}
      />
    </>
  )
}
