import { useCallback, useEffect, useState } from 'react'
import { ShieldQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'
import { isPlatformTauri } from '@/lib/platform/utils'
import {
  MAILBOX_UPDATED_EVENT,
  sessionMailbox,
  unwrapForDisplay,
  type MailboxUpdatedPayload,
  type MailEnvelope,
} from '@/lib/sessionMailbox'
import type { UnlistenFn } from '@/services/events/types'

/** The backend's deadline for a held message (HELD_TTL_MS). */
export const HELD_TTL_MS = 5 * 60_000

/** How often the list is re-read, so an expiry shows up without an event. */
const REFRESH_MS = 15_000

/**
 * Messages from other sessions that this session holds for its user
 * (Details > "Ask me before delivering"). Each is shown as plain text with
 * Approve (delivered once, like any message) and Deny (dropped). Nothing is
 * delivered, and no run is started, until the user approves; a message nobody
 * answers is dropped after five minutes and its sender is told.
 *
 * Approving only releases the text to this session's agent as untrusted mail.
 * It never approves a permission prompt or changes a setting.
 */
export function HeldInboundStack({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [held, setHeld] = useState<MailEnvelope[]>([])
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(() => {
    if (!isPlatformTauri()) return
    void sessionMailbox
      .held(sessionId)
      .then((list) => {
        setHeld(list)
        setNow(Date.now())
      })
      .catch((e) => console.warn('[mailbox] held list failed:', e))
  }, [sessionId])

  useEffect(() => {
    if (!isPlatformTauri()) return
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    let unlisten: UnlistenFn | undefined
    let cancelled = false
    void serviceHub
      .events()
      .listen<MailboxUpdatedPayload>(MAILBOX_UPDATED_EVENT, ({ payload }) => {
        if (payload?.sessionId === sessionId) refresh()
      })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch((e) => console.warn('[mailbox] listen failed:', e))
    return () => {
      cancelled = true
      clearInterval(timer)
      unlisten?.()
    }
  }, [refresh, serviceHub, sessionId])

  const decide = (m: MailEnvelope, approve: boolean) => {
    setHeld((list) => list.filter((x) => x.id !== m.id))
    const call = approve ? sessionMailbox.approveHeld : sessionMailbox.denyHeld
    void call(sessionId, m.id)
      .catch((e) => console.warn('[mailbox] held decision failed:', e))
      .finally(refresh)
  }

  if (held.length === 0) return null
  return (
    <div
      role="region"
      aria-label={t('messaging:held.title')}
      data-testid="cowork-held-inbound"
      className="mt-2 space-y-2"
    >
      <div
        role="status"
        className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-sm font-medium text-foreground"
      >
        <ShieldQuestion size={14} aria-hidden className="shrink-0 text-warning" />
        {t('messaging:held.banner', { count: held.length })}
      </div>
      {held.map((m) => {
        const left = Math.max(
          0,
          Math.ceil((m.createdAt + HELD_TTL_MS - now) / 60_000)
        )
        const name = m.from.displayName
        return (
          <section
            key={m.id}
            data-testid={`held-inbound-${m.id}`}
            className="space-y-2 rounded-lg border border-border bg-card px-3.5 py-3 text-sm"
          >
            <div className="flex items-center gap-2 text-muted-foreground">
              <h3 className="font-medium text-foreground">
                {t('messaging:held.from', { name })}
              </h3>
              {m.origin === 'notice' && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {t('messaging:held.notice')}
                </span>
              )}
              <span className="ml-auto shrink-0 text-xs tabular-nums">
                {t('messaging:held.expires', { minutes: left })}
              </span>
            </div>
            <p className="whitespace-pre-wrap break-words text-foreground">
              {unwrapForDisplay(m.text)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('messaging:untrustedNote')}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-7"
                data-testid="held-inbound-approve"
                aria-label={t('messaging:held.approveLabel', { name })}
                onClick={() => decide(m, true)}
              >
                {t('messaging:held.approve')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                data-testid="held-inbound-deny"
                aria-label={t('messaging:held.denyLabel', { name })}
                onClick={() => decide(m, false)}
              >
                {t('messaging:held.deny')}
              </Button>
            </div>
          </section>
        )
      })}
    </div>
  )
}
