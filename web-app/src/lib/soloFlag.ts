/**
 * Whether this window is a "New window" conversation window.
 *
 * Kept in a module of its own with no imports so the stores and providers that
 * must behave differently in such a window can read it without pulling in the
 * window machinery (and without import cycles).
 *
 * Read once at load from the URL's `chatWindow` flag, so in-window navigation,
 * which may drop the query, cannot turn the full app chrome back on.
 */
export const SOLO_FLAG = 'chatWindow'

const params = new URLSearchParams(
  typeof window === 'undefined' ? '' : window.location.search
)
const solo = params.has(SOLO_FLAG)

/** True in a window opened by "New window" (or a spare kept for one). */
export function isChatWindow(): boolean {
  return solo
}

/** The session a Cowork chat window was opened for, from its URL. */
export function initialSoloSession(): string | null {
  return params.get('session')
}

/** True in a spare window that has not been given a conversation yet. */
export function isSoloSpare(): boolean {
  return solo && params.has('spare')
}
