import { PauseCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import {
  isInterrupted,
  unfinishedReply,
  type InterruptedChoice,
} from '@/lib/coworkInflight'

/**
 * A turn the app stopped under (AH-026).
 *
 * Shown when the session holds a checkpoint of a run that is not running here:
 * the app was closed or killed mid-turn. The completed steps are kept either
 * way; the user chooses whether the unfinished reply goes with them, and the
 * run continues from there. Nothing is resumed on its own.
 */
export function CoworkInterruptedTurn({
  sessionId,
  running,
  onContinue,
}: {
  sessionId: string
  running: boolean
  onContinue: () => void
}) {
  const { t } = useTranslation()
  const record = useCoworkSessions(
    (s) => s.sessions.find((x) => x.id === sessionId)?.inFlight
  )
  const liveRunId = useCoworkRun((s) => s.runs[sessionId]?.runId)
  if (!isInterrupted(record, liveRunId)) return null
  const calls = record.turns.filter((turn) => turn.role === 'tool').length
  const partial = unfinishedReply(record)
  const take = (choice: InterruptedChoice) => {
    if (useCoworkSessions.getState().recoverInFlight(sessionId, choice)) onContinue()
  }
  return (
    <div
      role="status"
      data-testid="cowork-interrupted-turn"
      data-run={record.runId}
      data-calls={calls}
      data-partial-chars={partial.length}
      className="mt-2 space-y-1 rounded-md border border-border px-3 py-2 text-xs"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <PauseCircle size={14} aria-hidden className="shrink-0" />
        <span>{t('common:run.interrupted')}</span>
      </div>
      <div className="text-muted-foreground">
        {partial
          ? t('common:run.interruptedDetail', { count: calls, calls, chars: partial.length })
          : t('common:run.interruptedNoReply', { count: calls, calls })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          data-testid="cowork-interrupted-continue"
          disabled={running}
          onClick={() => take('continue')}
        >
          {t('common:run.interruptedContinue')}
        </Button>
        {partial ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            data-testid="cowork-interrupted-discard"
            disabled={running}
            onClick={() => take('discard-partial')}
          >
            {t('common:run.interruptedDiscard')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
