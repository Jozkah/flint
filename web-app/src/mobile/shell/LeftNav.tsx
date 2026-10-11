import { useEffect, useState } from 'react'
import type { SessionSummary } from '@/lib/remote/protocol'
import { D, FlintMark } from '../ui/bits'
import { I } from '../ui/icons'
import { closeAll, go, openSheet, useApp } from '../state/app'
import { useRpc } from '../state/rpc'
import { byKind, grouped, reachLabel, useSessions } from '../state/sessions'
import type { Route } from '../state/router'
import { t } from '../i18n'
import { headlineOf, modelOf, sortCampaigns } from '../state/campaigns'
import { MORE_ROUTES, initialTab, tabForRoute, writeTab, type NavTab } from './navTabs'
import './leftNavTabs.css'

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

function NavRow({
  icon,
  label,
  active,
  onClick,
  count,
  testId,
  expanded,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick: () => void
  count?: React.ReactNode
  testId?: string
  expanded?: boolean
}) {
  return (
    <button
      type="button"
      className={`row${active ? ' act' : ''}`}
      onClick={onClick}
      data-testid={testId}
      aria-expanded={expanded}
    >
      {icon}
      <span className="tx">
        <b style={{ fontWeight: 400 }}>{label}</b>
      </span>
      {count}
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
  const campaignList = useRpc('campaigns.list', {})
  const [allChats, setAllChats] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  // The tab follows the page; pages both tabs share keep the one showing.
  const [tab, setTab] = useState<NavTab>(() => initialTab(route))
  useEffect(() => {
    const next = tabForRoute(route)
    if (next) setTab((cur) => (cur === next ? cur : next))
  }, [route])
  const choose = (next: NavTab) => {
    setTab(next)
    writeTab(next)
  }

  const isActive = (r: Route) =>
    r.name === route.name && (!('id' in r) || ('id' in route && route.id === r.id))
  const is = (...names: Route['name'][]) => names.includes(route.name)

  const cowork = byKind(sessions, 'cowork')
  const rooms = byKind(sessions, 'room')
  const chats = byKind(sessions, 'chat')
  const cw = grouped(cowork)
  const activeCowork = cowork.filter((s) => s.status === 'running' || s.status === 'waiting').length
  const shownChats = allChats ? chats : chats.slice(0, CHATS_SHOWN)
  const ch = grouped(shownChats)
  const liveRooms = rooms.filter((r) => r.status === 'running' || r.status === 'waiting').slice(0, 4)
  const loaded = status.data?.modelsLoaded ?? 0

  const live = sortCampaigns(campaignList.data?.campaigns ?? []).filter(
    (c) => !['done', 'failed', 'cancelled'].includes(c.status)
  )
  const liveRows = live.slice(0, 4).map((c) => ({ c, h: headlineOf(modelOf(c)) }))
  const progress = live.reduce(
    (a, c) => {
      const h = headlineOf(modelOf(c))
      return { done: a.done + h.done, total: a.total + h.total }
    },
    { done: 0, total: 0 }
  )

  const resume = (
    <NavRow
      icon={<D n="sb-dashboard" />}
      label={t('nav.resume')}
      active={is('overview')}
      onClick={() => go({ name: 'overview' })}
      testId="nav-resume"
    />
  )
  const modelsRow = (
    <NavRow
      icon={<D n="x-cube" />}
      label={t('models.title')}
      active={is('models')}
      onClick={() => go({ name: 'models' })}
      count={models.data && <span className="cnt">{models.data.models.length}</span>}
      testId="nav-models"
    />
  )
  const discoverRow = (
    <NavRow
      icon={<I n="globe" size={16} />}
      label={t('nav.discover')}
      active={is('hf')}
      onClick={() => go({ name: 'hf' })}
      testId="nav-discover"
    />
  )

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
      <div role="tablist" aria-label={t('nav.tabs')} className="ntabs" data-testid="nav-tabs">
        {(['chat', 'cowork'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`nav-tab-${id}`}
            onClick={() => choose(id)}
          >
            {id === 'chat' ? t('nav.tabChat') : t('nav.tabCowork')}
            {id === 'cowork' && activeCowork > 0 && <span className="cnt">{activeCowork}</span>}
          </button>
        ))}
      </div>
      <div className="navs lnav" role="tabpanel">
        {resume}
        {tab === 'chat' && (
          <>
            <NavRow
              icon={<D n="x-edit" />}
              label={t('home.title')}
              active={route.name === 'home' && route.mode !== 'cowork' && route.mode !== 'room'}
              onClick={() => go({ name: 'home', mode: 'chat' })}
              testId="nav-new-chat"
            />
            <NavRow
              icon={<D n="x-library" />}
              label={t('library.title')}
              active={is('library')}
              onClick={() => go({ name: 'library' })}
            />
            {modelsRow}
            {discoverRow}

            <div className="ng">
              <span>{t('chat.crumb')}</span>
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
          </>
        )}
        {tab === 'cowork' && (
          <>
            <NavRow
              icon={<I n="sparkles" size={16} />}
              label={t('nav.newSession')}
              active={route.name === 'home' && (route.mode === 'cowork' || route.mode === 'room')}
              onClick={() => go({ name: 'home', mode: 'cowork' })}
              testId="nav-new-session"
            />
            <NavRow
              icon={<I n="flow" size={16} />}
              label={t('nav.campaigns')}
              active={is('campaigns', 'campaign')}
              onClick={() => go({ name: 'campaigns' })}
              testId="nav-campaigns"
              count={
                progress.total > 0 && (
                  <span className="cnt" data-testid="nav-campaigns-progress">
                    {t('campaigns.tasksDone', { done: progress.done, total: progress.total })}
                  </span>
                )
              }
            />
            {liveRows.length > 0 && (
              <div className="sub">
                {liveRows.map(({ c, h }) => {
                  const attention = h.key === 'attention' || h.key === 'review'
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`row${route.name === 'campaign' && route.id === c.id ? ' act' : ''}`}
                      data-testid="nav-campaign-row"
                      onClick={() => go({ name: 'campaign', id: c.id })}
                    >
                      <span className={`sd ${attention ? 'wait' : 'run'}`} />
                      <span className="tx">
                        <b style={{ fontWeight: 400 }}>{c.title || t('common.untitled')}</b>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            <NavRow
              icon={<D n="x-rooms" />}
              label={t('rooms.title')}
              active={is('rooms')}
              onClick={() => go({ name: 'rooms' })}
              count={rooms.length > 0 && <span className="cnt">{rooms.length}</span>}
            />
            {liveRooms.length > 0 && (
              <div className="sub">
                {liveRooms.map((s) => (
                  <SessionRow key={s.id} s={s} active={isActive({ name: 'room', id: s.id })} />
                ))}
              </div>
            )}
            <NavRow icon={<D n="x-palette" />} label={t('studio.title')} active={is('studio')} onClick={() => go({ name: 'studio' })} />
            <NavRow icon={<D n="flow" />} label={t('tools.title')} active={is('tools')} onClick={() => go({ name: 'tools' })} />
            {modelsRow}
            {discoverRow}
            <NavRow
              icon={<I n="more" size={16} />}
              label={t('nav.more')}
              onClick={() => setMoreOpen((o) => !o)}
              expanded={moreOpen}
              testId="nav-more"
            />
            {moreOpen && (
              <div className="sub" data-testid="nav-more-items">
                {MORE_ROUTES.map((r) => (
                  <NavRow
                    key={r.name === 'settings-sub' ? r.sub : r.name}
                    icon={<D n={r.name === 'archive' ? 'x-disk' : r.name === 'system' ? 'x-monitor' : 'x-server'} />}
                    label={r.name === 'archive' ? t('archive.title') : r.name === 'system' ? t('system.title') : t('settings.rows.localApi')}
                    active={r.name === 'settings-sub' ? route.name === 'settings-sub' && route.sub === r.sub : is(r.name)}
                    onClick={() => go(r)}
                  />
                ))}
              </div>
            )}

            <div className="ng">
              <span>{t('nav.sessions')}</span>
              <button type="button" className="ib" onClick={() => openSheet('coworkmenu')} aria-label={t('nav.coworkMenu')}>
                <I n="more" />
              </button>
            </div>
            {cowork.length === 0 && <div className="gh">{t('nav.noSessions')}</div>}
            {cw.groups.map(([g, list]) => (
              <div key={g} style={{ display: 'contents' }}>
                <div className="gh">
                  <I n="group" />
                  {g} <span className="cnt">{list.length}</span>
                </div>
                {list.map((s) => (
                  <SessionRow key={s.id} s={s} active={isActive({ name: 'cowork', id: s.id })} />
                ))}
              </div>
            ))}
            {cw.loose.slice(0, 12).map((s) => (
              <SessionRow key={s.id} s={s} active={isActive({ name: 'cowork', id: s.id })} />
            ))}
          </>
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
