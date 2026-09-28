import { useState } from 'react'
import type { RoomDetail } from '@/lib/remote/protocol'
import { TopThread } from '../shell/TopBar'
import { Composer } from '../shell/Composer'
import { ROOM_STATUS } from '../shell/labels'
import { I } from '../ui/icons'
import { Avatar, Empty, Loading } from '../ui/bits'
import { compact, duration, speakerColor } from '../ui/format'
import { Prose } from '../ui/messages'
import { act, openDrawer, openSheet } from '../state/app'
import { useRpc } from '../state/rpc'
import { useStickToBottom } from '../ui/hooks'

function UsageStrip({ room }: { room: RoomDetail }) {
  const { usage: u, limits: l } = room
  return (
    <div className="usage">
      <span>
        Turns <b>{u.turns} / {l.maxTurns}</b>
      </span>
      <span>
        Rounds <b>{u.rounds} / {l.maxRounds}</b>
      </span>
      <span>
        Tokens <b>{compact(u.tokens)} / {compact(l.maxTotalTokens)}</b>
      </span>
      {u.costUsd !== null && (
        <span>
          Cost <b>${u.costUsd.toFixed(2)}{l.maxCostUsd !== null ? ` / $${l.maxCostUsd.toFixed(2)}` : ''}</b>
        </span>
      )}
      <span>
        Time <b>{duration(u.activeMs)} / {duration(l.maxDurationMs)}</b>
      </span>
    </div>
  )
}

export default function Room({ id }: { id: string }) {
  const { data: room, error } = useRpc('rooms.get', { id })
  const msgs = useRpc('thread.messages', { id, kind: 'room', limit: 100 })
  const messages = msgs.data?.messages ?? []
  const ref = useStickToBottom(messages.length)
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
            {room ? `${ROOM_STATUS[room.roomStatus] ?? 'Room'} · Room` : 'Room'}
          </>
        }
        title={room?.title || 'Room'}
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
              <b>{running ? `${next.name} is speaking` : 'Waiting for you'}</b>
              <small>
                {running
                  ? `${next.role} · ${next.model} · Round ${Math.max(1, room.round)} of ${room.limits.maxRounds}`
                  : 'Choose who speaks next, or reply'}
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
              <b>Objective</b>
            </div>
            {room.objective}
          </div>
        )}
        {msgs.data && messages.length === 0 && <Empty>No one has spoken yet.</Empty>}
        {messages.map((m) => {
          const p = byName(m.author)
          const isUser = m.role === 'user'
          return (
            <div key={m.id} className="rm msg">
              <div className="who">
                {!isUser && p && <Avatar id={p.model} provider={p.provider} name={p.name} size={16} />}
                <b style={p && room ? { color: speakerColor(room, p.id) } : undefined}>{isUser ? 'You' : (m.author ?? 'Moderator')}</b>
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
      </div>
      <Composer
        placeholder="Write to the room… use @ to mention someone"
        label="Message to the room"
        top={
          <div className="to">
            <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
              To
            </span>
            <button type="button" className="chip" aria-pressed={to === 'everyone'} onClick={() => setTo('everyone')}>
              <I n="at" size={12} />
              Everyone
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
            <button type="button" className="ib" aria-label="Mention" onClick={() => setTo('everyone')}>
              <I n="at" />
            </button>
            <button type="button" className="ib" onClick={() => openDrawer('right', 'discussion')} aria-label="Steer the discussion">
              <I n="flag" />
            </button>
            <button type="button" className="ib" onClick={() => openDrawer('right', 'participants')} aria-label="Reasoning">
              <I n="bulb" />
            </button>
          </>
        }
        onSend={async (text) => (await act('room.send', { id, text, to: to === 'everyone' ? null : to })) !== undefined}
      />
    </>
  )
}
