import { useShallow } from 'zustand/shallow'
import { PauseCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useMessageQueue } from '@/stores/message-queue-store'

/**
 * Input typed for a run that did not take it: the run failed, was stopped,
 * hit a limit, or the app restarted before it was delivered. janhq/jan#8864.
 *
 * Shown for the session it was typed in, with the choice left to the user.
 * Sending it releases it to go as the next request once the session is idle;
 * discarding it removes it. Nothing held is ever sent on its own or dropped
 * without being shown.
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
    useShallow((s) => s.getQueue(sessionId).filter((m) => m.held))
  )
  if (held.length === 0) return null
  return (
    <div
      role="status"
      data-testid="cowork-held-input"
      className="mt-2 space-y-1 rounded-md border border-border px-3 py-2 text-xs"
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
  )
}
