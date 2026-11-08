import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { lastUserText } from '@/components/shell/nav/RowPreview'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import { isSessionEmpty } from '@/lib/coworkSessionStart'

/**
 * What the Cowork sidebar shows for one session. The sidebar selects these
 * instead of the sessions themselves, so a change to a field it does not show
 * (a run checkpoint, the code panel, the budget) leaves the list alone. Menu
 * and export actions read the full session from the store when they run
 * (`fullCoworkSession`).
 */
export type CoworkSessionView = {
  id: string
  title: string
  updated: CoworkSession['updated']
  folder: CoworkSession['folder']
  model: CoworkSession['model']
  remote: CoworkSession['remote']
  remoteStatus: CoworkSession['remoteStatus']
  campaign: CoworkSession['campaign']
  /** The session this one was forked from, or null. */
  forkedFrom: string | null
  /** The last thing asked, from the conversation or from its turns. */
  summary: string | undefined
  messageCount: number
  /** No content yet (`isSessionEmpty`). */
  empty: boolean
  pendingInputCount: number
}

function viewOf(session: CoworkSession): CoworkSessionView {
  return {
    id: session.id,
    title: session.title,
    updated: session.updated,
    folder: session.folder,
    model: session.model,
    remote: session.remote,
    remoteStatus: session.remoteStatus,
    campaign: session.campaign,
    forkedFrom: session.forkedFrom?.sessionId ?? null,
    summary:
      lastUserText(session.messages) ??
      session.turns.filter((turn) => turn.role === 'user').at(-1)?.content,
    messageCount: session.messages.length || session.turns.length,
    empty: isSessionEmpty(session),
    pendingInputCount: session.pendingInput?.length ?? 0,
  }
}

function sameView(a: CoworkSessionView, b: CoworkSessionView): boolean {
  for (const key of Object.keys(a) as (keyof CoworkSessionView)[]) {
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}

/**
 * A selector that projects the sessions to views, keeping the previous view
 * object for a session whose shown fields did not change. With `useShallow`
 * the selected array is then equal whenever nothing shown changed.
 */
export function createSessionViewProjector(): (
  sessions: readonly CoworkSession[]
) => CoworkSessionView[] {
  // A session object that did not change is not projected again.
  const fresh = new WeakMap<CoworkSession, CoworkSessionView>()
  let previous = new Map<string, CoworkSessionView>()
  return (sessions) => {
    const next = new Map<string, CoworkSessionView>()
    const out = sessions.map((session) => {
      let view = fresh.get(session)
      if (!view) {
        view = viewOf(session)
        fresh.set(session, view)
      }
      const before = previous.get(session.id)
      const kept = before && sameView(before, view) ? before : view
      next.set(session.id, kept)
      return kept
    })
    previous = next
    return out
  }
}

/** Every session as a sidebar view; re-renders only when a shown field changes. */
export function useCoworkSessionViews(): CoworkSessionView[] {
  const project = useMemo(() => createSessionViewProjector(), [])
  return useCoworkSessions(useShallow((s) => project(s.sessions)))
}

/** The full session behind a view, read when an action runs. */
export function fullCoworkSession(id: string): CoworkSession | undefined {
  return useCoworkSessions.getState().sessions.find((s) => s.id === id)
}
