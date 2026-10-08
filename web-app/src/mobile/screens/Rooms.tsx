import { useState } from 'react'
import type { SessionSummary } from '@/lib/remote/protocol'
import { TopMain } from '../shell/TopBar'
import { I } from '../ui/icons'
import { Tx } from '../ui/trans'
import { Avatar, Empty, Loading, Pills } from '../ui/bits'
import { ago, compact } from '../ui/format'
import { go, openSheet } from '../state/app'
import { useRpc } from '../state/rpc'
import { byKind, useSessions } from '../state/sessions'
import { ROOM_STATUS } from '../shell/labels'
import { t } from '../i18n'

const MODE = { 'round-robin': t('rooms.mode.roundRobin'), 'user-selected': t('rooms.mode.userSelected'), 'moderator-selected': t('rooms.mode.moderatorSelected') } as const

function RoomCard({ s }: { s: SessionSummary }) {
  const { data: room } = useRpc('rooms.get', { id: s.id })
  const status = room?.roomStatus ?? (s.status === 'running' ? 'running' : 'completed')
  return (
    <div className="rc" role="button" onClick={() => go({ name: 'room', id: s.id })} data-testid="room-card">
      <h3>
        {s.title || t('rooms.untitled')}
        <span
          role="button"
          aria-label={t('rooms.menu')}
          onClick={(e) => {
            e.stopPropagation()
            openSheet('roommenu', { id: s.id, title: s.title })
          }}
        >
          <I n="more" style={{ color: 'var(--muted-foreground)' }} />
        </span>
      </h3>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {status === 'running' ? (
          <span className="chip">
            <I n="loader" size={11} spin="slow" />
            {t('rooms.running')}
          </span>
        ) : status === 'awaiting-user' ? (
          <span className="chip warn">
            <I n="shield" size={11} />
            {t('rooms.waitingForYou')}
          </span>
        ) : (
          <span className={`chip${status === 'completed' ? ' ok' : ''}`}>
            <span className="d" />
            {ROOM_STATUS[status] ?? status}
          </span>
        )}
        {room && <span className="chip">{MODE[room.mode]}</span>}
      </div>
      {room?.objective && <p>{room.objective}</p>}
      {room && room.participants.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
          <span className="stack">
            {room.participants.map((p) => (
              <Avatar key={p.id} id={p.model} provider={p.provider} name={p.name} size={18} />
            ))}
          </span>
          {room.participants.map((p) => p.name).join(', ')}
        </div>
      )}
      {room && (
        <>
          <div className="kv">
            <span>
              <Tx k="rooms.turnOf" parts={{ turn: <b style={{ color: 'var(--foreground)' }}>{room.usage.turns}</b>, max: room.limits.maxTurns }} />
            </span>
            <span className="muted">{t('rooms.tokens', { count: compact(room.usage.tokens) })}</span>
          </div>
          <div className="meter">
            <i style={{ width: `${Math.min(100, (room.usage.turns / Math.max(1, room.limits.maxTurns)) * 100)}%` }} />
          </div>
        </>
      )}
      <div className="kv">
        <span className="subtle" style={{ fontSize: 11.5 }}>
          {t('rooms.updated', { when: ago(s.updatedAt) })}
        </span>
        <span />
      </div>
    </div>
  )
}

export default function Rooms() {
  const { sessions, loading, data } = useSessions()
  const [filter, setFilter] = useState<'all' | 'active' | 'finished'>('all')
  const rooms = byKind(sessions, 'room')
  const running = rooms.filter((r) => r.status === 'running').length
  const waiting = rooms.filter((r) => r.status === 'waiting').length
  const paused = rooms.filter((r) => r.status === 'paused').length
  const shown = rooms.filter((r) =>
    filter === 'all' ? true : filter === 'active' ? r.status === 'running' || r.status === 'waiting' || r.status === 'paused' : r.status === 'done'
  )
  return (
    <>
      <TopMain crumb={t('common.workspace')} title={t('rooms.title')} />
      <div className="scroll">
        <div className="ph">
          <h2>{t('rooms.title')}</h2>
          <p>{t('rooms.intro')}</p>
        </div>
        <div className="kpis">
          <div className="kpi">
            <small>
              {t('rooms.running')} <I n="play" size={12} />
            </small>
            <b>{running}</b>
            <em>{t('rooms.paused', { count: paused })}</em>
          </div>
          <div className="kpi">
            <small>
              {t('rooms.waitingForYou')} <I n="bell" size={12} />
            </small>
            <b>{waiting}</b>
            <em style={waiting ? { color: 'var(--warning)' } : undefined}>{waiting ? t('rooms.needsPick') : t('rooms.nothingWaiting')}</em>
          </div>
        </div>
        <Pills
          items={[
            { id: 'all', label: t('rooms.filters.all') },
            { id: 'active', label: t('rooms.filters.active') },
            { id: 'finished', label: t('rooms.filters.finished') },
          ]}
          value={filter}
          onChange={setFilter}
        />
        {loading && !data && <Loading />}
        {data && shown.length === 0 && <Empty>{t('rooms.empty')}</Empty>}
        {shown.slice(0, 20).map((s) => (
          <RoomCard key={s.id} s={s} />
        ))}
        <button type="button" className="btn pri big" style={{ marginTop: 6 }} onClick={() => openSheet('roomnew')}>
          <I n="plus" />
          {t('rooms.new')}
        </button>
      </div>
    </>
  )
}
