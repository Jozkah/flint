import { useEffect } from 'react'
import { useServiceHub } from '@/hooks/useServiceHub'
import { isPlatformTauri } from '@/lib/platform/utils'
import { getMailboxDelivery } from '@/lib/mailboxDelivery'
import {
  MAILBOX_UPDATED_EVENT,
  type MailboxUpdatedPayload,
} from '@/lib/sessionMailbox'
import type { UnlistenFn } from '@/services/events/types'

/**
 * Delivers mail from other agent sessions into Cowork sessions. Mounted once at
 * the root: listens for `agent-mailbox-updated`, and sweeps every session once
 * on startup for mail that arrived while the app was closed.
 */
export function useMailboxDelivery() {
  const serviceHub = useServiceHub()

  useEffect(() => {
    if (!isPlatformTauri()) return

    const delivery = getMailboxDelivery()
    const stop = delivery.start()
    void delivery.sweep()

    let unlisten: UnlistenFn | undefined
    let cancelled = false
    void serviceHub
      .events()
      .listen<MailboxUpdatedPayload>(MAILBOX_UPDATED_EVENT, ({ payload }) => {
        void delivery.onEvent(payload)
      })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch((e) => console.warn('[mailbox] listen failed:', e))

    return () => {
      cancelled = true
      unlisten?.()
      stop()
    }
  }, [serviceHub])
}
