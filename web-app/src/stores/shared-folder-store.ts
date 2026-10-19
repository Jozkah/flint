import { create } from 'zustand'
import { getServiceHub } from '@/hooks/useServiceHub'
import {
  SHARED_FOLDER_UPDATED_EVENT,
  sharedFolder,
  type SharedFolderGroup,
} from '@/lib/sharedFolder'

/**
 * Which sessions share a folder with another live session, for the sidebar
 * mark and the hover card. One entry per session, holding how many others are
 * in its folder, so a row subscribes to its own number and nothing else: a
 * peer joining one folder re-renders only the rows of that folder.
 */
type State = {
  /** Session id -> how many other live sessions share its folder. */
  others: Record<string, number>
  set: (groups: SharedFolderGroup[]) => void
}

/** Pure: the per-session counts of an overview. */
export function countOthers(
  groups: SharedFolderGroup[]
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const g of groups)
    if (g.sessions.length > 1)
      for (const s of g.sessions) out[s.sessionId] = g.sessions.length - 1
  return out
}

const same = (a: Record<string, number>, b: Record<string, number>) => {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  )
}

export const useSharedFolderStore = create<State>()((set) => ({
  others: {},
  // Unchanged counts keep the same object, so no selector fires.
  set: (groups) =>
    set((state) => {
      const next = countOthers(groups)
      return same(state.others, next) ? state : { others: next }
    }),
}))

/** How many other live sessions share this session's folder (0: none). */
export function useSharedWith(sessionId: string | null | undefined): number {
  return useSharedFolderStore((s) =>
    sessionId ? (s.others[sessionId] ?? 0) : 0
  )
}

export const SHARED_FOLDER_DEBOUNCE_MS = 300

/**
 * Keeps the store current: reads the overview once, then again (debounced)
 * after each `agent-shared-folder-updated`. A backend that has none (the
 * browser build) leaves the store empty without a sound. Returns the stop
 * function.
 */
export function startSharedFolderSync(): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = () => {
    void sharedFolder
      .overview()
      .then((groups) => {
        if (!stopped) useSharedFolderStore.getState().set(groups)
      })
      .catch(() => undefined)
  }
  const later = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(read, SHARED_FOLDER_DEBOUNCE_MS)
  }
  read()
  let unlisten: (() => void) | undefined
  void getServiceHub()
    .events()
    .listen(SHARED_FOLDER_UPDATED_EVENT, later)
    .then((fn) => {
      if (stopped) fn()
      else unlisten = fn
    })
    .catch(() => undefined)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    unlisten?.()
  }
}
