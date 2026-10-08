import { useState } from 'react'
import type { SessionSummary } from '@/lib/remote/protocol'
import { D, FlintMark } from '../ui/bits'
import { I } from '../ui/icons'
import { closeAll, go, openSheet, useApp } from '../state/app'
import { useRpc } from '../state/rpc'
import { byKind, grouped, reachLabel, useSessions } from '../state/sessions'
import type { Route } from '../state/router'
import { t } from '../i18n'

const CHATS_SHOWN = 12

function StatusDot({ s }: { s: SessionSummary }) {
  if (s.status === 'waiting') return <span className="sd wait" />
  if (s.status === 'running') return <span className="sd run" />
  return <span style={{ width: 7, flex: 'none' }} />
}

function SessionRow({ s, active }: { s: SessionSummary; active: boolean }) {
  return (
    <button
      type="button"
      className={`row${active ? ' act' : ''}`}
      onClick={() => go({ name: s.kind, id: s.id })}
      onContextMenu={(e) => {
        e.preventDefault()
        openSheet(s.kind === 'chat' ? 'threadmenu' : s.kind === 'cowork' ? 'sessmenu' : 'roommenu', { id: s.id, title: s.title })
      }}
    >
      {s.kind === 'room' && s.status === 'running' ? <I n="loader" size={12} spin="slow" /> : <StatusDot s={s} />}
      <span className="tx">
        <b style={{ fontWeight: s.status === 'idle' || s.status === 'done' ? 400 : 500 }}>{s.title || t('common.untitled')}</b>
      </span>
      {s.status === 'waiting' && s.kind === 'cowork' && (
        <span className="cnt" style={{ color: 'var(--warning)' }}>
          <I n="shield" size={12} />
        </span>
      )}
    </button>
  )
}

export function LeftNav() {
  const route = useApp((s) => s.route)
  const computer = useApp((s) => s.computerName) ?? t('common.yourComputerCap')
  const conn = useApp((s) => s.conn)
  const { sessions } = useSessions()
  const status = useRpc('status', {})
  const models = useRpc('models.list', {})
  const [coworkOpen, setCoworkOpen] = useState(true)
  const [allChats, setAllChats] = useState(false)

  const isActive = (r: Route) =>
    r.name === route.name && (!('id' in r) || ('id' in route && route.id === r.id))
  const act = (name: Route['name']) => (route.name === name ? ' act' : '')

  const cowork = byKind(sessions, 'cowork')
  const rooms = byKind(sessions, 'room')
  const chats = byKind(sessions, 'chat')
  const cw = grouped(cowork)
  const activeCowork = cowork.filter((s) => s.status === 'running' || s.status === 'waiting').length
  const shownChats = allChats ? chats : chats.slice(0, CHATS_SHOWN)
  const ch = grouped(shownChats)
  const liveRooms = rooms.filter((r) => r.status === 'running' || r.status === 'waiting').slice(0, 4)
  const loaded = status.data?.modelsLoaded ?? 0

  return (
    <>
      <div className="dpad" />
      <div className="brand">
        <FlintMark />
        <b>Flint</b>
        <button type="button" className="ib" onClick={closeAll} aria-label={t('rightpanel.close')}>
          <D n="sidebar-right" />
        </button>
      </div>
      <div className="gline" />
      <button type="button" className="srch" onClick={() => openSheet('palette')}>
        <D n="search" />
        {t('nav.search')}
      </button>
      <div className="navs">
        <div className="ng">
          <span>{t('common.workspace')}</span>
        </div>
        <button type="button" className={`row${act('overview')}`} onClick={() => go({ name: 'overview' })}>
          <D n="sb-dashboard" />
          <span className="tx">
            <b style={{ fontWeight: 400 }}>{t('nav.overview')}</b>
          </span>
        </button>
        <button type="button" className={`row${act('home')}`} onClick={() => go({ name: 'home', mode: 'chat' })}>
          <D n="x-edit" />
          <span className="tx">
            <b style={{ fontWeight: 400 }}>{t('home.title')}</b>
          </span>
        </button>
        <button
          type="button"
          className={`row${route.name === 'cowork' ? ' act' : ''}`}
          onClick={() => setCoworkOpen((o) => !o)}
          aria-expanded={coworkOpen}
        >
          <D n="x-cowork" />
          <span className="tx">
            <b style={{ fontWeight: 400 }}>{t('home.modes.cowork')}</b>
          </span>
          {activeCowork > 0 && <span className="cnt">{activeCowork}</span>}
          <span
            role="button"
            tabIndex={0}
            className="ib"
            style={{ width: 24, height: 24 }}
            aria-label={t('nav.coworkMenu')}
            onClick={(e) => {
              e.stopPropagation()
              openSheet('coworkmenu')
            }}
          >
            <I n="more" size={14} />
          </span>
          <I n="chev" size={13} style={{ color: 'var(--muted-foreground)', transform: coworkOpen ? undefined : 'rotate(-90deg)' }} />
        </button>
        {coworkOpen && (
          <div className="sub">
            <button type="button" className="row" onClick={() => go({ name: 'home', mode: 'cowork' })}>
              <I n="plus" size={13} />
              {t('nav.newSession')}
            </button>
            {cw.groups.map(([g, list]) => (
              <div key={g} style={{ display: 'contents' }}>
                <div className="gh">
                  <I n="group" />
                  {g} <span className="cnt">{list.length}</span>
                </div>
                {list.slice(0, 6).map((s) => (
                  <SessionRow key={s.id} s={s} active={isActive({ name: 'cowork', id: s.id })} />
                ))}
              </div>
            ))}
            {cw.loose.slice(0, 6).map((s) => (
              <SessionRow key={s.id} s={s} active={isActive({ name: 'cowork', id: s.id })} />
            ))}
          </div>
        )}
        <button type="button" className={`row${act('rooms')}`} onClick={() => go({ name: 'rooms' })}>
          <D n="x-rooms" />
          <span className="tx">
            <b style={{ fontWeight: 400 }}>{t('rooms.title')}</b>
          </span>
          {rooms.length > 0 && <span className="cnt">{rooms.length}</span>}
        </button>
        {liveRooms.length > 0 && (
          <div className="sub">
            {liveRooms.map((s) => (
              <SessionRow key={s.id} s={s} active={isActive({ name: 'room', id: s.id })} />
            ))}
          </div>
        )}
        <button type="button" className={`row${act('library')}`} onClick={() => go({ name: 'library' })}>
          <D n="x-library" />
          <span className="tx">
            <b style={{ fontWeight: 400 }}>{t('library.title')}</b>
          </span>
        </button>
        <button type="button" className={`row${act('studio')}`} onClick={() => go({ name: 'studio' })}>
          <D n="x-palette" />
          <span className="tx">
            <b style={{ fontWeight: 400 }}>{t('studio.title')}</b>
          </span>
        </button>
        <button type="button" className={`row${act('archive')}`} onClick={() => go({ name: 'archive' })}>
          <D n="x-disk" />
          <span className="tx">
            <b style={{ fontWeight: 400 }}>{t('archive.title')}</b>
          </span>
        </button>

        <div className="ng">
          <span>{t('models.crumb')}</span>
        </div>
        <button type="button" className={`row${act('models')}`} onClick={() => go({ name: 'models' })}>
          <D n="x-cube" />
          <span className="tx">
            <b style={{ fontWeight: 400 }}>{t('models.title')}</b>
          </span>
          {models.data && <span className="cnt">{models.data.models.length}</span>}
        </button>
        <button type="button" className={`row${act('tools')}`} onClick={() => go({ name: 'tools' })}>
          <D n="flow" />
          <span className="tx">
            <b style={{ fontWeight: 400 }}>{t('tools.title')}</b>
          </span>
        </button>
        <button type="button" className={`row${act('system')}`} onClick={() => go({ name: 'system' })}>
          <D n="x-monitor" />
          <span className="tx">
            <b style={{ fontWeight: 400 }}>{t('system.title')}</b>
          </span>
        </button>

        <div className="ng">
          <span>{t('chat.crumb')}</span>
          <button type="button" className="ib" onClick={() => go({ name: 'home', mode: 'chat' })} aria-label={t('home.title')}>
            <I n="plus" />
          </button>
          <button type="button" className="ib" onClick={() => openSheet('palette')} aria-label={t('nav.searchChats')}>
            <I n="search" />
          </button>
          <button type="button" className="ib" onClick={() => openSheet('chatfilter')} aria-label={t('nav.filter')}>
            <I n="sliders" />
          </button>
        </div>
        {chats.length === 0 && <div className="gh">{t('nav.noChats')}</div>}
        {chats.some((s) => s.pinned) && (
          <>
            <div className="gh" data-testid="pinned">
              <I n="pin" />
              {t('nav.pinned')}
            </div>
            {chats
              .filter((s) => s.pinned)
              .map((s) => (
                <SessionRow key={`pin-${s.id}`} s={s} active={isActive({ name: 'chat', id: s.id })} />
              ))}
          </>
        )}
        {ch.groups.map(([g, list]) => (
          <div key={g} style={{ display: 'contents' }}>
            <div className="gh">
              <I n="group" />
              {g} <span className="cnt">{list.length}</span>
            </div>
            {list.map((s) => (
              <SessionRow key={s.id} s={s} active={isActive({ name: 'chat', id: s.id })} />
            ))}
          </div>
        ))}
        {ch.loose.length > 0 && ch.groups.length > 0 && <div className="gh">{t('nav.ungrouped')}</div>}
        {ch.loose.map((s) => (
          <SessionRow key={s.id} s={s} active={isActive({ name: 'chat', id: s.id })} />
        ))}
        {!allChats && chats.length > CHATS_SHOWN && (
          <button type="button" className="row" style={{ color: 'var(--muted-foreground)', fontSize: 12 }} onClick={() => setAllChats(true)}>
            {t('nav.showMore', { count: chats.length - CHATS_SHOWN })}
          </button>
        )}
      </div>
      <div className="foot">
        <button
          type="button"
          className={`row${route.name === 'settings' || route.name === 'settings-sub' || route.name === 'remote' ? ' act' : ''}`}
          onClick={() => go({ name: 'settings' })}
        >
          <D n="sb-settings" />
          <span className="tx">
            <b style={{ fontWeight: 400 }}>{t('settings.title')}</b>
          </span>
        </button>
        <button type="button" className="stat" onClick={() => openSheet('conn')} data-testid="connection-card">
          <span className="av">
            <FlintMark />
            <i className={conn} />
          </span>
          <span className="tx">
            <b>{computer}</b>
            <small>
              {conn === 'connected'
                ? t('nav.connected', { count: loaded, via: reachLabel() })
                : conn === 'connecting'
                  ? t('nav.connecting', { via: reachLabel() })
                  : t('nav.offline', { via: reachLabel() })}
            </small>
          </span>
          <I n="chev" style={{ transform: 'rotate(180deg)', color: 'var(--muted-foreground)' }} />
        </button>
      </div>
    </>
  )
}
