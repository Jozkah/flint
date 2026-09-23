import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/** Default for {@link useAutoApproveLimit}'s `limit`. */
export const DEFAULT_AUTO_APPROVE_LIMIT = 50

type AutoApproveLimitState = {
  /**
   * After this many consecutive tool calls that ran without asking (auto
   * mode), the next one is put to the user as a checkpoint on a long
   * unattended run. `0` turns the pause off.
   */
  limit: number
  setLimit: (limit: number) => void
}

export const useAutoApproveLimit = create<AutoApproveLimitState>()(
  persist(
    (set) => ({
      limit: DEFAULT_AUTO_APPROVE_LIMIT,
      setLimit: (limit) =>
        set({ limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0 }),
    }),
    {
      name: 'auto-approve-limit',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ limit: state.limit }),
    }
  )
)

/** Consecutive unasked calls per session, since the user last answered. */
const streaks = new Map<string, number>()

/**
 * Count one call that would run without asking. Returns true when it is past
 * the limit and should be put to the user instead.
 */
export function noteAutoApproved(sessionId: string, limit: number): boolean {
  const next = (streaks.get(sessionId) ?? 0) + 1
  streaks.set(sessionId, next)
  return limit > 0 && next > limit
}

/** The user was asked: the session's streak starts over. */
export function resetAutoApproveStreak(sessionId: string): void {
  streaks.delete(sessionId)
}
