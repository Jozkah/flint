import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/** Default for {@link useAutoApproveLimit}'s `limit`. */
export const DEFAULT_AUTO_APPROVE_LIMIT = 50

/** Largest limit the setting accepts. Higher values are clamped to it. */
export const MAX_AUTO_APPROVE_LIMIT = 1000

/**
 * Bring any input -- a typed number, a string from an input field, a value
 * read back from storage -- into the accepted range: a whole number from `0`
 * (pause off) to {@link MAX_AUTO_APPROVE_LIMIT}. Anything unreadable falls
 * back to the default rather than silently turning the pause off.
 */
export function normalizeAutoApproveLimit(value: unknown): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN
  if (!Number.isFinite(n)) return DEFAULT_AUTO_APPROVE_LIMIT
  if (n <= 0) return 0
  return Math.min(MAX_AUTO_APPROVE_LIMIT, Math.floor(n))
}

type AutoApproveLimitState = {
  /**
   * After this many consecutive tool calls that ran without asking (auto
   * mode), the next one is put to the user as a checkpoint on a long
   * unattended run. `0` turns the pause off.
   */
  limit: number
  setLimit: (limit: number | string) => void
}

export const useAutoApproveLimit = create<AutoApproveLimitState>()(
  persist(
    (set) => ({
      limit: DEFAULT_AUTO_APPROVE_LIMIT,
      setLimit: (limit) => set({ limit: normalizeAutoApproveLimit(limit) }),
    }),
    {
      name: 'auto-approve-limit',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ limit: state.limit }),
      // A hand-edited or older stored value is brought back into range.
      merge: (persisted, current) => ({
        ...current,
        limit: normalizeAutoApproveLimit(
          (persisted as { limit?: unknown } | undefined)?.limit ??
            DEFAULT_AUTO_APPROVE_LIMIT
        ),
      }),
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
