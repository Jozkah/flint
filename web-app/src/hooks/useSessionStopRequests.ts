import { useEffect } from 'react'
import { useServiceHub } from '@/hooks/useServiceHub'
import { isPlatformTauri } from '@/lib/platform/utils'
import { getStopListener } from '@/lib/sessionStopListener'
import {
  STOP_REQUESTED_EVENT,
  type StopRequestedPayload,
} from '@/lib/sessionMailbox'
import type { UnlistenFn } from '@/services/events/types'

/**
 * Applies approved `stop_session` requests to the Cowork session they name.
 * Mounted once at the root, beside mailbox delivery, so a session running in
 * the background is reached whichever screen is showing.
 */
export function useSessionStopRequests() {
  const serviceHub = useServiceHub()

  useEffect(() => {
    if (!isPlatformTauri()) return
    const listener = getStopListener()
    let unlisten: UnlistenFn | undefined
    let cancelled = false
    void serviceHub
      .events()
      .listen<StopRequestedPayload>(STOP_REQUESTED_EVENT, ({ payload }) => {
        void listener.onEvent(payload)
      })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch((e) => console.warn('[stop] listen failed:', e))
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [serviceHub])
}
