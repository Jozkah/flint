import { stripSessionToolImages } from '@/lib/toolOutputImages'
import { coworkTurnsToUIMessages } from '@/lib/coworkTurns'
import {
  emptyCodePanelState,
  projectKeyOf,
  projectTab,
  sandboxTab,
  tabId,
  type CodeTab,
  type FileOrigin,
} from '@/lib/coworkCode'
import type { CoworkSession } from './types'

/** The `sandbox:` marker used by the v2 tab-path scheme. */
const LEGACY_SANDBOX_PREFIX = 'sandbox:'

/**
 * What of a session is written to disk. A flush maps every session, but the
 * store replaces a session object when it changes, so the result for an
 * unchanged one is reused instead of walking its history again.
 */
const savedForDisk = new WeakMap<CoworkSession, CoworkSession>()
export function sessionForDisk(session: CoworkSession): CoworkSession {
  const known = savedForDisk.get(session)
  if (known) return known
  const saved = stripSessionToolImages(session)
  let out: CoworkSession
  // A server session is a pointer: its transcript lives on the server.
  if (saved.remote) {
    out = { ...saved, turns: [], messages: [], inFlight: undefined, pendingInput: undefined }
  } else {
    out = saved.mode === 'bypass' ? { ...saved, mode: 'ask' as const } : saved
  }
  savedForDisk.set(session, out)
  return out
}

// v0 persisted an OpenAI-shaped `history` that could not represent tool
// calls, so replaying it dropped every tool turn. Rebuild the message
// list from `turns`, which did record them, and leave `history` in place
// untouched rather than mutating a blob a rollback would still read.
//
// v1 → v2 adds `codePanel`. Filled with the empty state rather than left
// absent so downstream code reads one shape; every other field is passed
// through untouched, so a v1 session loses nothing.
export function migrateCoworkSessions(persisted: unknown, version: number) {
  const state = persisted as { sessions?: CoworkSession[] } | undefined
  if (!state?.sessions) return persisted
  let sessions = state.sessions
  if (version < 1) {
    sessions = sessions.map((session) =>
      session.messages
        ? session
        : {
            ...session,
            messages: coworkTurnsToUIMessages(
              session.turns ?? [],
              session.id
            ),
          }
    )
  }
  if (version < 2) {
    sessions = sessions.map((session) =>
      session.codePanel
        ? session
        : { ...session, codePanel: emptyCodePanelState() }
    )
  }
  // v2 → v3: tabs were bare strings with a `sandbox:` prefix and no idea
  // which project they came from, so a tab opened against one project
  // would silently re-resolve inside the next one attached. Each becomes
  // a CodeTab carrying its origin; a project tab is keyed to the folder
  // the session has now, and dropped when there is none, because nothing
  // records which project it was actually read from.
  if (version < 3) {
    sessions = sessions.map((session) => {
      const legacy = session.codePanel as unknown as
        | { openPaths?: unknown; activePath?: unknown }
        | undefined
      if (!legacy || !Array.isArray(legacy.openPaths)) {
        return session.codePanel
          ? session
          : { ...session, codePanel: emptyCodePanelState() }
      }
      const projectKey = projectKeyOf(session.folder)
      const tabs: CodeTab[] = []
      for (const raw of legacy.openPaths) {
        if (typeof raw !== 'string' || !raw) continue
        if (raw.startsWith(LEGACY_SANDBOX_PREFIX)) {
          // The tab is stored on its own session, so that session owns it.
          tabs.push(
            sandboxTab(
              raw.slice(LEGACY_SANDBOX_PREFIX.length),
              session.id
            )
          )
        } else if (projectKey) {
          tabs.push(projectTab(raw, projectKey))
        }
      }
      const previousActive =
        typeof legacy.activePath === 'string' ? legacy.activePath : null
      const active = tabs.find((tab) =>
        previousActive === null
          ? false
          : previousActive.startsWith(LEGACY_SANDBOX_PREFIX)
            ? tab.origin.kind !== 'project' &&
              tab.path ===
                previousActive.slice(LEGACY_SANDBOX_PREFIX.length)
            : tab.origin.kind === 'project' && tab.path === previousActive
      )
      return {
        ...session,
        codePanel: {
          tabs,
          activeTabId: active
            ? tabId(active)
            : tabs[0]
              ? tabId(tabs[0])
              : null,
          expandedDirs: Array.isArray(
            (session.codePanel as unknown as { expandedDirs?: unknown })
              ?.expandedDirs
          )
            ? (session.codePanel as unknown as { expandedDirs: string[] })
                .expandedDirs
            : [],
          wordWrap: Boolean(
            (session.codePanel as unknown as { wordWrap?: unknown })
              ?.wordWrap
          ),
        },
      }
    })
  }
  // v3 → v4: sandbox and artifact origins gained a `sessionKey`. Without
  // one a tab has no owner, so it would be read against whichever
  // session happened to be open. Each is stamped with the session it is
  // stored on, which is the session that opened it.
  if (version < 4) {
    sessions = sessions.map((session) => {
      const panel = session.codePanel
      if (!panel?.tabs?.length) return session
      let changed = false
      const tabs = panel.tabs.map((tab) => {
        const origin = tab.origin as FileOrigin & { sessionKey?: string }
        if (
          (origin?.kind !== 'sandbox' && origin?.kind !== 'artifact') ||
          origin.sessionKey
        ) {
          return tab
        }
        changed = true
        return {
          ...tab,
          origin: { kind: origin.kind, sessionKey: session.id },
        }
      })
      if (!changed) return session
      // Tab ids embed the origin, so every id just changed. Re-derive
      // the active one from the tab it pointed at rather than leaving a
      // dangling id that would blank the viewer.
      const activeIndex = panel.tabs.findIndex(
        (tab) => tabId(tab) === panel.activeTabId
      )
      return {
        ...session,
        codePanel: {
          ...panel,
          tabs,
          activeTabId:
            activeIndex >= 0
              ? tabId(tabs[activeIndex])
              : panel.activeTabId,
        },
      }
    })
  }
  // v4 → v5: sessions gained an optional `campaign` pointer. Absent
  // means "not part of a campaign", which is every session saved
  // before it, so there is nothing to rewrite.
  return { ...state, sessions }
}
