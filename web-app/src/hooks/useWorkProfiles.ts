import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { backendStorage } from '@/lib/backendStorage'
import {
  classifyLocally,
  isWorkProfileId,
  workProfile,
  workProfileBlock,
  WORK_PROFILES,
  type WorkProfileId,
} from '@/lib/workProfiles'

/**
 * The work-profile opt-in and the user's edited profile texts, persisted;
 * each session's current profile, in memory. With the opt-in off no profile
 * is ever chosen and every run gets the global prompt alone.
 */
type SessionChoice = { id: WorkProfileId; manual: boolean }

type WorkProfilesState = {
  enabled: boolean
  /** Profile text the user wrote, by id. Absent means the default text. */
  overrides: Partial<Record<WorkProfileId, string>>
  /** Per session: the profile in use and whether the user picked it. */
  sessions: Record<string, SessionChoice>
  setEnabled: (enabled: boolean) => void
  setOverride: (id: WorkProfileId, text: string | null) => void
  choose: (sessionId: string, id: WorkProfileId, manual: boolean) => void
  clearManual: (sessionId: string) => void
  /** The prompt block for a session, or undefined when none applies. */
  blockFor: (sessionId: string | undefined) => string | undefined
  textFor: (id: WorkProfileId) => string
}

export const WORK_PROFILES_KEY = 'flint-work-profiles'

export const useWorkProfiles = create<WorkProfilesState>()(
  persist(
    (set, get) => ({
      enabled: false,
      overrides: {},
      sessions: {},
      setEnabled: (enabled) => set({ enabled }),
      setOverride: (id, text) =>
        set((s) => {
          const overrides = { ...s.overrides }
          if (text === null || text.trim() === workProfile(id).prompt.trim()) delete overrides[id]
          else overrides[id] = text
          return { overrides }
        }),
      choose: (sessionId, id, manual) =>
        set((s) => ({ sessions: { ...s.sessions, [sessionId]: { id, manual } } })),
      clearManual: (sessionId) =>
        set((s) => {
          const sessions = { ...s.sessions }
          delete sessions[sessionId]
          return { sessions }
        }),
      textFor: (id) => get().overrides[id] ?? workProfile(id).prompt,
      blockFor: (sessionId) => {
        const s = get()
        if (!s.enabled || !sessionId) return undefined
        const choice = s.sessions[sessionId]
        if (!choice) return undefined
        const text = s.textFor(choice.id)
        return text.trim() ? workProfileBlock(choice.id, text) : undefined
      },
    }),
    {
      name: WORK_PROFILES_KEY,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (s) =>
        ({ enabled: s.enabled, overrides: s.overrides }) as unknown as WorkProfilesState,
    }
  )
)

/**
 * Pick the profile for this message. A profile the user chose manually stays
 * pinned; an automatic choice is deliberately re-evaluated for every new
 * message so a session can move from e.g. Execute to Review or Debug as the
 * work changes. Otherwise Jev decides when `askJev` is given (it returns a
 * profile id or null), falling back to the keyword match; Jev gets at most
 * `timeoutMs`, so a slow answer never holds up the run.
 */
export async function chooseWorkProfile(
  sessionId: string,
  message: string,
  askJev?: (message: string, options: { name: string; description: string }[]) => Promise<string | null>,
  timeoutMs = 2500
): Promise<WorkProfileId | undefined> {
  const store = useWorkProfiles.getState()
  if (!store.enabled || !message.trim()) return undefined

  // Only a user-picked profile is sticky. Automatic choices are per-message:
  // keeping the first auto choice for the whole session made one early
  // `execute` fallback appear to be Jev choosing Execute forever.
  const current = store.sessions[sessionId]
  if (current?.manual) return current.id

  let id: WorkProfileId = classifyLocally(message)
  if (askJev) {
    const options = WORK_PROFILES.map((p) => ({ name: p.id, description: p.description }))
    const answer = await Promise.race([
      askJev(message, options).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
    ])
    if (isWorkProfileId(answer)) id = answer
  }
  store.choose(sessionId, id, false)
  return id
}
