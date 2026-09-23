import { useEffect, useState } from 'react'
import { subscribeAnnouncements } from '@/lib/groups/announce'

/** Polite live region for group moves, expansion, membership and errors. */
export function GroupAnnouncer() {
  const [message, setMessage] = useState('')
  useEffect(
    () =>
      subscribeAnnouncements((m) => {
        // Clear first so repeating the same message is announced again.
        setMessage('')
        requestAnimationFrame(() => setMessage(m))
      }),
    []
  )
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="group-announcer">
      {message}
    </div>
  )
}
