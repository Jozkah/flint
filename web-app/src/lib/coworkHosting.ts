import { createContext, useContext, useEffect } from 'react'
import { create } from 'zustand'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'

/**
 * Which Cowork sessions a visible page is driving right now.
 *
 * A Cowork run is driven by the mounted page of its session (routes/cowork.tsx),
 * so the campaign run host must not mount a second copy of a page that is
 * already there: one writer per session id. Pages the host itself mounts are
 * marked by `HiddenHostContext` and are not counted.
 */
type HostingState = {
  counts: Record<string, number>
  add: (sid: string) => void
  remove: (sid: string) => void
}

export const useHostedSessions = create<HostingState>()((set) => ({
  counts: {},
  add: (sid) =>
    set((s) => ({ counts: { ...s.counts, [sid]: (s.counts[sid] ?? 0) + 1 } })),
  remove: (sid) =>
    set((s) => {
      const n = (s.counts[sid] ?? 0) - 1
      const counts = { ...s.counts }
      if (n > 0) counts[sid] = n
      else delete counts[sid]
      return { counts }
    }),
}))

/** True inside the pages the campaign run host mounts. */
export const HiddenHostContext = createContext(false)

/** Called by CoworkPage with the session it shows (its pane's, else the current one). */
export function useRegisterHostedSession(paneSessionId?: string | null): void {
  const hidden = useContext(HiddenHostContext)
  const current = useCoworkSessions((s) => s.currentId)
  const sid = paneSessionId ?? current
  useEffect(() => {
    if (hidden || !sid) return
    useHostedSessions.getState().add(sid)
    return () => useHostedSessions.getState().remove(sid)
  }, [hidden, sid])
}
