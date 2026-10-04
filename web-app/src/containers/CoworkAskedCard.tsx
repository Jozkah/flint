import { MessageSquareReply } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import type { AskedSession } from '@/lib/askedSessions'

/**
 * "Asked <title>": what the agent in this session sent to another session, and
 * what came back. The answer is another session's text, so it is plain text
 * and says so. Opening the other session is a plain navigation.
 */
export function CoworkAskedCard({ asked }: { asked: AskedSession }) {
  const { t } = useTranslation()
  const exists = useCoworkSessions((s) =>
    asked.sessionId ? s.sessions.some((x) => x.id === asked.sessionId) : false
  )
  const name = asked.name || t('messaging:asked.unknownName')
  return (
    <section
      data-testid={`agent-asked-${asked.key}`}
      className="my-2 space-y-1 rounded-md border border-border px-3 py-2 text-xs"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <MessageSquareReply size={14} aria-hidden className="shrink-0" />
        <h3 className="font-medium text-foreground">
          {t('messaging:asked.title', { name })}
        </h3>
        <span data-testid="agent-asked-status" role="status">
          {t(`messaging:asked.${asked.status}`)}
        </span>
        {exists && asked.sessionId && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-6 px-2"
            data-testid="agent-asked-open"
            aria-label={t('messaging:asked.openLabel', { name })}
            onClick={() =>
              useCoworkSessions.getState().selectSession(asked.sessionId!)
            }
          >
            {t('messaging:asked.open')}
          </Button>
        )}
      </div>
      {asked.answer !== null && (
        <>
          <p
            data-testid="agent-asked-answer"
            className="whitespace-pre-wrap break-words"
          >
            {asked.answer}
          </p>
          <p className="text-muted-foreground">
            {t('messaging:asked.untrusted')}
          </p>
        </>
      )}
    </section>
  )
}
