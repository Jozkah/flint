import { useCallback, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { errorText } from '@/lib/errorText'
import {
  scheduleCancelRun,
  scheduleRuns,
  type ScheduleRun,
} from '@/lib/schedules'
import { formatWhen, statusTone, tokenCount } from './scheduleFormat'

type Props = {
  taskId: string
  /** Changes when the task's runs may have changed, to re-read the list. */
  version?: unknown
}

/**
 * The runs of one task, newest first. A finished run links to the conversation
 * it produced; the tool calls it was denied are listed under "Blocked on".
 */
export function ScheduleRunHistory({ taskId, version }: Props) {
  const { t } = useTranslation()
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null)

  const load = useCallback(async () => {
    try {
      setRuns(await scheduleRuns(taskId, 30))
    } catch (e) {
      toast.error(t('schedules:loadFailed'), { description: errorText(e) })
      setRuns([])
    }
  }, [taskId, t])

  useEffect(() => {
    void load()
  }, [load, version])

  const stop = async (runId: string) => {
    try {
      await scheduleCancelRun(taskId, runId)
      await load()
    } catch (e) {
      toast.error(t('schedules:runFailed'), { description: errorText(e) })
    }
  }

  if (runs === null) return null
  if (runs.length === 0) {
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">{t('schedules:list.noRuns')}</p>
    )
  }
  return (
    <ul className="flex flex-col divide-y divide-dashed divide-border" data-testid="schedule-runs">
      {runs.map((run) => (
        <li key={run.id} className="flex flex-col gap-1.5 px-1 py-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={statusTone(run.status)} live={run.status === 'running'} dot>
              {t(`schedules:status.${run.status}`)}
            </Chip>
            <span className="text-foreground">{formatWhen(run.startedAtMs)}</span>
            <span className="text-muted-foreground">{t(`schedules:trigger.${run.trigger}`)}</span>
            {run.spend.turns > 0 && (
              <span className="text-muted-foreground">
                {t('schedules:run.spend', {
                  turns: run.spend.turns,
                  tokens: tokenCount(run.spend).toLocaleString(),
                })}
              </span>
            )}
            <span className="ml-auto flex items-center gap-1">
              {run.status === 'running' && (
                <Button size="xs" variant="outline" onClick={() => void stop(run.id)}>
                  {t('schedules:run.cancel')}
                </Button>
              )}
              {run.sessionId && run.status !== 'skipped' && (
                <Link
                  to="/threads/$threadId"
                  params={{ threadId: run.sessionId }}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  {t('schedules:run.openTranscript')}
                </Link>
              )}
            </span>
          </div>
          {run.summary && (
            <p className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">{run.summary}</p>
          )}
          {run.error && <p className="text-muted-foreground">{run.error}</p>}
          {run.branch && (
            <p className="font-mono text-muted-foreground">
              {t('schedules:run.branch', { branch: run.branch })}
            </p>
          )}
          {run.blockedOn.length > 0 && (
            <div className="rounded-md border-[0.8px] border-border bg-card px-2.5 py-2">
              <p className="font-medium text-foreground">{t('schedules:run.blockedOn')}</p>
              <p className="mb-1 text-muted-foreground">{t('schedules:run.blockedOnHint')}</p>
              <ul className="list-disc pl-4 font-mono text-[11px] text-secondary-foreground">
                {run.blockedOn.map((line, i) => (
                  <li key={i} className="break-all">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
