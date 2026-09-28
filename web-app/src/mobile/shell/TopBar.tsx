import type { ReactNode } from 'react'
import { D } from '../ui/bits'
import { I } from '../ui/icons'
import { back, go, openDrawer, openSheet, useApp } from '../state/app'
import { useRpc } from '../state/rpc'

/** Runs in flight and approvals waiting, from the computer's status. */
export function LiveChips() {
  const { data } = useRpc('status', {})
  const runs = data?.runs.length ?? 0
  const approvals = data?.approvalsWaiting ?? 0
  const list = useRpc('approvals.list', {}, approvals > 0)
  const first = list.data?.approvals[0]
  return (
    <>
      {runs > 0 && (
        <button
          type="button"
          className="runpill"
          onClick={() => openSheet('runs')}
          aria-label={`${runs} running`}
          data-testid="runs-pill"
        >
          <I n="loader" spin="slow" />
          <span>{runs}</span>
        </button>
      )}
      {approvals > 0 && (
        <button
          type="button"
          className="apill"
          onClick={() => (first ? go({ name: 'cowork', id: first.threadId }) : go({ name: 'notifications' }))}
          aria-label={`${approvals} approvals waiting`}
          data-testid="approvals-pill"
        >
          <I n="shield" />
          <span>{approvals}</span>
        </button>
      )}
    </>
  )
}

function Bell() {
  const unread = useApp((s) => s.notices.some((n) => n.unread))
  return (
    <button type="button" className="ib" onClick={() => go({ name: 'notifications' })} aria-label="Notifications">
      <D n="bell" size={18} />
      {unread && <span className="dotb" />}
    </button>
  )
}

export function SidebarButton() {
  return (
    <button type="button" className="ib" onClick={() => openDrawer('left')} aria-label="Open navigation">
      <D n="sidebar-right" size={18} style={{ transform: 'rotate(180deg)' }} />
    </button>
  )
}

export function PanelButton() {
  return (
    <button type="button" className="ib" onClick={() => openDrawer('right')} aria-label="Open panel">
      <D n="sidebar-right" size={18} />
    </button>
  )
}

/** The main screens' bar: sidebar, crumb and title, live chips, bell. */
export function TopMain({ crumb, title, extra }: { crumb: ReactNode; title: ReactNode; extra?: ReactNode }) {
  return (
    <div className="top">
      <SidebarButton />
      <div className="crumb">
        <small>{crumb}</small>
        <b>{title}</b>
      </div>
      {extra}
      <LiveChips />
      <Bell />
    </div>
  )
}

/** A conversation's bar: sidebar, crumb and title, ⋯ menu, panel. */
export function TopThread({
  crumb,
  title,
  menu,
  panel = true,
}: {
  crumb: ReactNode
  title: ReactNode
  menu?: () => void
  panel?: boolean
}) {
  return (
    <div className="top">
      <SidebarButton />
      <div className="crumb">
        <small style={{ display: 'flex', gap: 5, alignItems: 'center' }}>{crumb}</small>
        <b>{title}</b>
      </div>
      {menu && (
        <button type="button" className="ib" onClick={menu} aria-label="More">
          <I n="more" />
        </button>
      )}
      {panel && <PanelButton />}
    </div>
  )
}

/** A pushed page's bar: back, title, an optional action. */
export function TopBack({ crumb, title, action }: { crumb?: ReactNode; title: ReactNode; action?: ReactNode }) {
  return (
    <div className="top">
      <button type="button" className="ib" onClick={back} aria-label="Back">
        <I n="back" />
      </button>
      <div className="crumb">
        {crumb && <small>{crumb}</small>}
        <b>{title}</b>
      </div>
      {action}
    </div>
  )
}
