import { useCallback, useEffect, useState } from 'react'
import { UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  dismissGuestMessage,
  guestApi,
  sendGuestMessage,
  type GuestApi,
  type GuestPending,
} from '@/lib/guestShare'

/** How often a thread's waiting guest messages are looked up. */
const REFRESH_MS = 5_000

/**
 * Above the composer: what a guest of this thread has written, waiting for the
 * owner. Each is plain text with Send (goes into the thread as a user turn,
 * marked as from a guest) and Dismiss. Nothing is sent or run until the owner
 * presses Send.
 */
export function GuestRequestsBanner({
  threadId,
  api = guestApi,
  send = sendGuestMessage,
  dismiss = dismissGuestMessage,
}: {
  threadId: string
  api?: Pick<GuestApi, 'pending' | 'resolve'>
  send?: typeof sendGuestMessage
  dismiss?: typeof dismissGuestMessage
}) {
  const { t } = useTranslation()
  const [items, setItems] = useState<GuestPending[]>([])

  const refresh = useCallback(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    api
      .pending(threadId)
      .then((list) => setItems(list))
      .catch(() => setItems([]))
  }, [api, threadId])

  useEffect(() => {
    setItems([])
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const act = async (item: GuestPending, action: 'send' | 'dismiss') => {
    try {
      if (action === 'send') {
        await send(item, api)
        toast.success(t('chat:guest.sentToast'))
      } else {
        await dismiss(item, api)
      }
    } catch {
      toast.error(t('chat:guest.failed'))
    }
    setItems((current) => current.filter((p) => p.id !== item.id))
    refresh()
  }

  if (items.length === 0) return null
  return (
    <div className="mb-2 flex flex-col gap-1.5" data-testid="guest-requests">
      {items.map((item) => (
        <div
          key={item.id}
          role="status"
          className="flex min-w-0 items-start gap-2 rounded-lg bg-muted/60 px-2.5 py-2 text-xs text-secondary-foreground"
        >
          <UserRound aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t('chat:guest.requestTitle')}</div>
            {/* Plain text, never rendered as markdown or HTML. */}
            <p className="line-clamp-4 whitespace-pre-wrap break-words" data-testid="guest-request-text">
              {item.text}
            </p>
            {item.attachments.length > 0 && (
              <p className="text-muted-foreground">
                {t('chat:guest.attachments', {
                  count: item.attachments.length,
                  names: item.attachments.map((a) => a.name).join(', '),
                })}
              </p>
            )}
          </div>
          <Button size="sm" onClick={() => void act(item, 'send')} data-testid="guest-send">
            {t('chat:guest.send')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void act(item, 'dismiss')}
            data-testid="guest-dismiss"
          >
            {t('chat:guest.dismiss')}
          </Button>
        </div>
      ))}
    </div>
  )
}
