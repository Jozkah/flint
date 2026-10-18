import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import { Mail, PauseCircle } from 'lucide-react'
import { sessionMailbox } from '@/lib/sessionMailbox'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useMessageQueue, type QueuedMessage } from '@/stores/message-queue-store'
import { AgentMessageCard } from '@/containers/AgentMessageCard'
import { SessionMessagingToggle } from '@/containers/SessionMessagingToggle'

type MailMessage = QueuedMessage & { from: NonNullable<QueuedMessage['from']> }

/**
 * Input typed for a run that did not take it: the run failed, was stopped,
 * hit a limit, or the app restarted before it was delivered. janhq/jan#8864.
 *
 * Shown for the session it was typed in, with the choice left to the user.
 * Sending it releases it to go as the next request once the session is idle;
 * discarding it removes it. Nothing held is ever sent on its own or dropped
 * without being shown.
 *
 * Held mail from other agent sessions (docs/SESSION_MESSAGING.md) is shown
 * separately, as message cards with the Automatic wake-ups setting beside them.
 */
export function CoworkHeldInput({
  sessionId,
  running,
}: {
  sessionId: string
  running: boolean
}) {
  const { t } = useTranslation()
  const held = useMessageQueue(
    useShallow((s) => s.getQueue(sessionId).filter((m) => m.held && !m.from))
  )
  const mail = useMessageQueue(
    useShallow((s) =>
      s.getQueue(sessionId).filter((m): m is MailMessage => !!m.held && !!m.from)
    )
  )
  if (held.length === 0 && mail.length === 0) return null
  return (
    <>
      {held.length > 0 && (
        <div
          role="status"
          data-testid="cowork-held-input"
          className="mt-2 space-y-1.5 rounded-xl border-[0.8px] border-border bg-card px-3 py-2.5 text-xs motion-safe:animate-rise-in"
        >
          <div className="flex items-center gap-2 text-muted-foreground">
            <PauseCircle size={14} aria-hidden className="shrink-0" />
            <span>{t('common:steering.held', { count: held.length })}</span>
          </div>
          {held.map((m) => (
            <div
              key={m.id}
              data-testid={`cowork-held-${m.id}`}
              className="flex items-center gap-2"
            >
              <span className="min-w-0 flex-1 truncate" title={m.text}>
                {m.text}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                data-testid="cowork-held-send"
                disabled={running}
                onClick={() => useMessageQueue.getState().release(sessionId, m.id)}
              >
                {t('common:steering.send')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                data-testid="cowork-held-discard"
                onClick={() =>
                  useMessageQueue.getState().removeMessage(sessionId, m.id)
                }
              >
                {t('common:steering.discard')}
              </Button>
            </div>
          ))}
        </div>
      )}
      {mail.length > 0 && <HeldMailStack sessionId={sessionId} mail={mail} />}
    </>
  )
}

/** Cards shown before the rest fold into "+N more". */
export const HELD_MAIL_VISIBLE = 3

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Held mail from other sessions, oldest first: a banner that says how many
 * wait (scrolled into view when more arrive, so mail that lands while the
 * session is idle is never below the fold unannounced), the untrusted note
 * once, at most HELD_MAIL_VISIBLE cards with the rest behind "+N more", and
 * Dismiss all.
 */
function HeldMailStack({
  sessionId,
  mail,
}: {
  sessionId: string
  mail: MailMessage[]
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const bannerRef = useRef<HTMLDivElement>(null)
  const ordered = useMemo(
    () => [...mail].sort((a, b) => a.createdAt - b.createdAt),
    [mail]
  )
  const shown = expanded ? ordered : ordered.slice(0, HELD_MAIL_VISIBLE)
  const hidden = ordered.length - shown.length

  // A new message: bring the banner into view.
  const seen = useRef(0)
  useEffect(() => {
    if (ordered.length > seen.current) {
      bannerRef.current?.scrollIntoView?.({
        block: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      })
    }
    seen.current = ordered.length
  }, [ordered.length])

  const dismissAll = () => {
    const ids = ordered.map((m) => m.from.messageId)
    const queue = useMessageQueue.getState()
    for (const m of ordered) queue.removeMessage(sessionId, m.id)
    void sessionMailbox
      .markRead(sessionId, ids)
      .catch((e) => console.warn('[mailbox] mark read failed:', e))
  }

  return (
    <div
      role="region"
      aria-label={t('messaging:heldTitle')}
      data-testid="cowork-held-mail"
      className="mt-2 space-y-2"
    >
      <div
        ref={bannerRef}
        tabIndex={-1}
        role="status"
        data-testid="held-mail-banner"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring motion-safe:animate-rise-in"
      >
        <Mail size={14} aria-hidden className="shrink-0 text-warning" />
        <span className="font-medium">
          {t('messaging:heldBanner', { count: ordered.length })}
        </span>
        <span
          data-testid="held-mail-untrusted"
          className="basis-full text-xs text-muted-foreground"
        >
          {t('messaging:untrustedNote')}
        </span>
      </div>
      {shown.map((m) => (
        <AgentMessageCard key={m.id} sessionId={sessionId} message={m} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {hidden > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            data-testid="held-mail-more"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
          >
            {t('messaging:moreHeld', { count: hidden })}
          </Button>
        )}
        {ordered.length > 1 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            data-testid="held-mail-dismiss-all"
            onClick={dismissAll}
          >
            {t('messaging:dismissAll')}
          </Button>
        )}
      </div>
      <SessionMessagingToggle sessionId={sessionId} />
    </div>
  )
}
