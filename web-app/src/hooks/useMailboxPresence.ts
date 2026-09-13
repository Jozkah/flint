import { useEffect } from 'react'
import { isPlatformTauri } from '@/lib/platform/utils'
import { createPresenceSync } from '@/lib/mailboxPresence'

/**
 * Registers Cowork sessions and their run status with the backend mailbox.
 * Mounted once at the root (GlobalEventHandler), so presence is kept whichever
 * screen is showing.
 */
export function useMailboxPresence() {
  useEffect(() => {
    if (!isPlatformTauri()) return
    try {
      return createPresenceSync().start()
    } catch (e) {
      console.warn('[mailbox] presence sync failed to start:', e)
      return
    }
  }, [])
}
