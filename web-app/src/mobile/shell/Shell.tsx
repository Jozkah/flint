import { lazy, Suspense, useEffect, useRef, type ComponentType } from 'react'
import { FlintMark, Loading } from '../ui/bits'
import { act, app, closeAll, closeSheet, go, useApp } from '../state/app'
import type { Route } from '../state/router'
import { LeftNav } from './LeftNav'
import { RightPanel } from './RightPanel'
import { SheetBody } from './sheets'

// Screens load on demand; the shell, drawers and sheets are in the entry.
const Home = lazy(() => import('../screens/Home'))
const Chat = lazy(() => import('../screens/Chat'))
const Cowork = lazy(() => import('../screens/Cowork'))
const Room = lazy(() => import('../screens/Room'))
const Rooms = lazy(() => import('../screens/Rooms'))
const Overview = lazy(() => import('../screens/Overview'))
const Library = lazy(() => import('../screens/Library'))
const Models = lazy(() => import('../screens/Models'))
const Tools = lazy(() => import('../screens/Tools'))
const System = lazy(() => import('../screens/System'))
const Notifications = lazy(() => import('../screens/Notifications'))
const Settings = lazy(() => import('../screens/Settings'))
const SettingsSub = lazy(() => import('../screens/SettingsSub'))

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <Home />
    case 'chat':
      return <Chat id={route.id} />
    case 'cowork':
      return <Cowork id={route.id} />
    case 'room':
      return <Room id={route.id} />
    case 'settings-sub':
      return <SettingsSub sub={route.sub} />
    case 'remote':
      return <SettingsSub sub="remote" />
    default: {
      const map: Record<string, ComponentType> = {
        rooms: Rooms,
        overview: Overview,
        library: Library,
        models: Models,
        tools: Tools,
        system: System,
        notifications: Notifications,
        settings: Settings,
      }
      const Cmp = map[route.name] ?? Home
      return <Cmp />
    }
  }
}

const routeKey = (r: Route) => ('id' in r ? `${r.name}:${r.id}` : 'sub' in r ? `sub:${r.sub}` : r.name)

/** Opens a drawer with a swipe in from the screen edge, closes it with a
 * swipe back (the design's gestures). */
function useEdgeSwipe(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let sx: number | null = null
    let sy = 0
    const start = (e: TouchEvent) => {
      sx = e.touches[0].clientX
      sy = e.touches[0].clientY
    }
    const end = (e: TouchEvent) => {
      if (sx === null) return
      const dx = e.changedTouches[0].clientX - sx
      const dy = Math.abs(e.changedTouches[0].clientY - sy)
      const w = el.clientWidth
      const { drawer, sheet, route } = app.get()
      const hasPanel = route.name === 'chat' || route.name === 'cowork' || route.name === 'room'
      if (dy < 50 && !sheet) {
        if (dx > 70 && sx < 30 && !drawer) app.set({ drawer: 'left' })
        else if (dx < -70 && sx > w - 30 && !drawer && hasPanel) app.set({ drawer: 'right' })
        else if (dx < -70 && drawer === 'left') closeAll()
        else if (dx > 70 && drawer === 'right') closeAll()
      }
      sx = null
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchend', end, { passive: true })
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchend', end)
    }
  }, [ref])
}

function Push() {
  const push = useApp((s) => s.push)
  return (
    <div
      className={`push${push ? ' on' : ''}`}
      role="status"
      aria-live="polite"
      onClick={() => {
        if (!push) return
        app.set({ push: null })
        if (push.route) go(push.route)
      }}
    >
      {push && (
        <>
          <FlintMark />
          <span className="tx">
            <b>
              {push.title}
              <span>now</span>
            </b>
            {push.body}
            {push.requestId && (
              <span className="pa">
                <button
                  type="button"
                  className="btn sm dan"
                  onClick={(e) => {
                    e.stopPropagation()
                    app.set({ push: null })
                    void act('approvals.respond', { requestId: push.requestId, decision: 'deny' }, 'Denied · from this phone')
                  }}
                >
                  Deny
                </button>
                <button
                  type="button"
                  className="btn sm pri"
                  onClick={(e) => {
                    e.stopPropagation()
                    app.set({ push: null })
                    void act('approvals.respond', { requestId: push.requestId, decision: 'allow', scope: 'once' }, 'Allowed once · from this phone')
                  }}
                >
                  Allow once
                </button>
              </span>
            )}
          </span>
        </>
      )}
    </div>
  )
}

function Toast() {
  const toast = useApp((s) => s.toast)
  return (
    <div className={`toast${toast ? ' on' : ''}`} role="status" aria-live="polite" data-testid="toast">
      {toast?.text}
    </div>
  )
}

export function Shell() {
  const route = useApp((s) => s.route)
  const drawer = useApp((s) => s.drawer)
  const sheet = useApp((s) => s.sheet)
  const ref = useRef<HTMLDivElement>(null)
  useEdgeSwipe(ref)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAll()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app" ref={ref}>
      <div id="views">
        <Suspense fallback={<Loading />}>
          <section className="view" key={routeKey(route)}>
            <Screen route={route} />
          </section>
        </Suspense>
      </div>
      <div className={`scrim${drawer ? ' on' : ''}`} onClick={closeAll} />
      <nav className={`drawer l${drawer === 'left' ? ' open' : ''}`} aria-label="Navigation" aria-hidden={drawer !== 'left'} inert={drawer !== 'left'}>
        <LeftNav />
      </nav>
      <aside className={`drawer r${drawer === 'right' ? ' open' : ''}`} aria-label="Panel" aria-hidden={drawer !== 'right'} inert={drawer !== 'right'}>
        {drawer === 'right' && (
          <Suspense fallback={null}>
            <RightPanel />
          </Suspense>
        )}
      </aside>
      <div className={`scrim${sheet ? ' on' : ''}`} style={{ zIndex: 40 }} onClick={closeSheet} />
      <div className={`sheet${sheet ? ' open' : ''}`} role="dialog" aria-modal="true" aria-hidden={!sheet} inert={!sheet}>
        {sheet && <SheetBody key={sheet.name + JSON.stringify(sheet.props ?? {})} name={sheet.name} props={sheet.props ?? {}} />}
      </div>
      <Push />
      <Toast />
    </div>
  )
}
