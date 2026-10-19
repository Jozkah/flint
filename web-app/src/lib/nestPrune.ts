import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useThreads } from '@/hooks/useThreads'
import { useNestExpanded } from '@/stores/nest-expanded-store'

/**
 * A parent that is deleted leaves its "unfolded" flag behind in the browser's
 * storage for good. Only parents seen leaving a store are forgotten: a list
 * that has simply not loaded yet (or one filtered by a group) must not wipe
 * the choices of rows that still exist.
 */
export function removedIds(prev: Iterable<string>, next: Iterable<string>): string[] {
  const keep = new Set(next)
  return [...prev].filter((id) => !keep.has(id))
}

let installed = false

export function installNestPrune(): void {
  if (installed) return
  installed = true
  // Guarded: a test may stand in for a store with a bare mock.
  useCoworkSessions.subscribe?.((state, prev) => {
    if (state.sessions === prev.sessions) return
    const gone = removedIds(
      prev.sessions.map((s) => s.id),
      state.sessions.map((s) => s.id)
    )
    if (gone.length > 0) useNestExpanded.getState().forget('cowork', gone)
  })
  useThreads.subscribe?.((state, prev) => {
    if (state.threads === prev.threads) return
    const gone = removedIds(Object.keys(prev.threads), Object.keys(state.threads))
    if (gone.length > 0) useNestExpanded.getState().forget('chats', gone)
  })
}

installNestPrune()
