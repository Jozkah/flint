/**
 * Screen-reader announcements for group changes. `GroupAnnouncer` renders the
 * polite live region; anything can call `announce()`.
 */
type Listener = (message: string) => void
const listeners = new Set<Listener>()
let last = ''

export function announce(message: string) {
  last = message
  for (const l of listeners) l(message)
}

export function subscribeAnnouncements(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const lastAnnouncement = () => last
