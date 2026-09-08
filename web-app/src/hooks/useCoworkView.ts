import { create } from 'zustand'

/** Which side panel a session had open. */
export type CoworkRail =
  | { kind: 'preview'; path?: string }
  | { kind: 'diff' }
  | { kind: 'code' }
  | { kind: 'tasks' }
  | null

/**
 * What a Cowork session looked like when the user left it.
 *
 * Held outside the route component so that stepping into Settings and back --
 * which unmounts the route -- returns to the same session in the same state
 * rather than to a reset view. Deliberately not persisted: this is where you
 * were a moment ago, not a preference, and a restart legitimately starts fresh.
 */
type State = {
  railBySession: Record<string, CoworkRail>
  scrollBySession: Record<string, number>
  setRail: (sessionId: string | undefined, rail: CoworkRail) => void
  rememberScroll: (sessionId: string | undefined, offset: number) => void
  forget: (sessionId: string) => void
}

export const useCoworkView = create<State>()((set) => ({
  railBySession: {},
  scrollBySession: {},

  setRail: (sessionId, rail) =>
    set((s) =>
      sessionId
        ? { railBySession: { ...s.railBySession, [sessionId]: rail } }
        : {}
    ),

  rememberScroll: (sessionId, offset) =>
    set((s) =>
      sessionId
        ? { scrollBySession: { ...s.scrollBySession, [sessionId]: offset } }
        : {}
    ),

  forget: (sessionId) =>
    set((s) => {
      const railBySession = { ...s.railBySession }
      const scrollBySession = { ...s.scrollBySession }
      delete railBySession[sessionId]
      delete scrollBySession[sessionId]
      return { railBySession, scrollBySession }
    }),
}))
