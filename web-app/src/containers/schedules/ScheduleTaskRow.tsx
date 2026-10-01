import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Icon } from '@/components/ui/icon'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ScheduledTaskView } from '@/lib/schedules'
import { describeSchedule, formatWhen, statusTone } from './scheduleFormat'
import { ScheduleRunHistory } from './ScheduleRunHistory'

type Props = {
  view: ScheduledTaskView
  onToggle: (enabled: boolean) => void
  onRunNow: () => void
  onEdit: () => void
  onDelete: () => void
}

/** One task: what it does and when, its controls, and its run history. */
export function ScheduleTaskRow({ view, onToggle, onRunNow, onEdit, onDelete }: Props) {
  const { t } = useTranslation()
  const [showHistory, setShowHistory] = useState(false)
  const { task, nextFires, lastRun, running } = view
  const next = nextFires[0]

  return (
    <div
      data-testid={`schedule-task-${task.id}`}
      className="flex flex-col gap-1 border-b border-dashed border-border px-3.5 py-3 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">{task.name}</span>
            {running && (
              <Chip tone="info" live dot>
                {t('schedules:list.running')}
              </Chip>
            )}
            {!task.enabled && <Chip>{t('schedules:list.disabled')}</Chip>}
          </div>
          <p className="text-xs text-muted-foreground">{describeSchedule(task.schedule, t)}</p>
          <p className="text-xs text-muted-foreground">
            {task.enabled && next
              ? t('schedules:list.nextRun', { when: formatWhen(next) })
              : t('schedules:list.noNextRun')}
            {' · '}
            {lastRun ? (
              <>
                {t('schedules:list.lastRun', { when: formatWhen(lastRun.startedAtMs) })}{' '}
                <Chip tone={statusTone(lastRun.status)} dot className="ml-1 align-middle">
                  {t(`schedules:status.${lastRun.status}`)}
                </Chip>
              </>
            ) : (
              t('schedules:list.neverRun')
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Switch
            checked={task.enabled}
            onCheckedChange={onToggle}
            aria-label={`${t('schedules:list.enabled')} ${task.name}`}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={running}
            onClick={onRunNow}
            aria-label={`${t('schedules:list.runNow')} ${task.name}`}
          >
            <Icon name="x-play" size={14} />
            {t('schedules:list.runNow')}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            title={t('schedules:list.edit')}
            aria-label={`${t('schedules:list.edit')} ${task.name}`}
            onClick={onEdit}
          >
            <Icon name="x-edit" size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            title={t('schedules:list.delete')}
            aria-label={`${t('schedules:list.delete')} ${task.name}`}
            onClick={onDelete}
          >
            <Icon name="x-trash" size={16} />
          </Button>
        </div>
      </div>
      <div>
        <button
          type="button"
          className="cursor-pointer text-xs font-medium text-primary hover:underline"
          aria-expanded={showHistory}
          onClick={() => setShowHistory((v) => !v)}
        >
          {showHistory ? t('schedules:list.hideHistory') : t('schedules:list.history')}
        </button>
        {showHistory && <ScheduleRunHistory taskId={task.id} version={lastRun?.id + String(lastRun?.status)} />}
      </div>
    </div>
  )
}
