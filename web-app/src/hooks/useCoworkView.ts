import { create } from 'zustand'

/** Which side panel a session had open. */
export type CoworkRail =
  | { kind: 'preview'; path?: string }
  /** `focusPath`: a file to bring into view, e.g. from a tool card. */
  | { kind: 'diff'; focusPath?: string }
  | { kind: 'code' }
  | { kind: 'tasks' }
  | { kind: 'timeline' }
  /** The agent's own browser, shown read-only (see AgentBrowserWindow). */
  | { kind: 'browser' }
  | { kind: 'background' }
  | null

/**
 * What a Cowork session looked like when the user left it.
 *
 * Held outside the route component so that stepping into Settings and back --
 * which unmounts the route -- returns to the same session in the same state
 * rather than to a reset view. Deliberately not persisted: this is where you
 * were a moment ago, not a preference, and a restart legitimately starts fresh.
 */
/**
 * The key for a view that has no session yet.
 *
 * A rail can be opened before the first message is sent, and dropping that on
 * the floor for want of a session id would make the toolbar do nothing.
 */
export const NO_SESSION = '__no-session__'

type State = {
  railBySession: Record<string, CoworkRail>
  scrollBySession: Record<string, number>
  setRail: (sessionId: string | undefined, rail: CoworkRail) => void
  rememberScroll: (sessionId: string | undefined, offset: number) => void
  adoptPreSession: (sessionId: string) => void
  forget: (sessionId: string) => void
}

export const useCoworkView = create<State>()((set) => ({
  railBySession: {},
  scrollBySession: {},

  setRail: (sessionId, rail) =>
    set((s) => ({
      railBySession: { ...s.railBySession, [sessionId ?? NO_SESSION]: rail },
    })),

  rememberScroll: (sessionId, offset) =>
    set((s) => ({
      scrollBySession: {
        ...s.scrollBySession,
        [sessionId ?? NO_SESSION]: offset,
      },
    })),

  /**
   * Hand the pre-session view to the session that was just created.
   *
   * A rail opened before the first message belongs to the session that message
   * starts; without this it would close the moment the session appeared.
   */
  adoptPreSession: (sessionId) =>
    set((s) => {
      const pending = s.railBySession[NO_SESSION]
      if (pending === undefined || s.railBySession[sessionId] !== undefined) {
        return {}
      }
      const railBySession = { ...s.railBySession, [sessionId]: pending }
      delete railBySession[NO_SESSION]
      return { railBySession }
    }),

  forget: (sessionId) =>
    set((s) => {
      const railBySession = { ...s.railBySession }
      const scrollBySession = { ...s.scrollBySession }
      delete railBySession[sessionId]
      delete scrollBySession[sessionId]
      return { railBySession, scrollBySession }
    }),
}))
