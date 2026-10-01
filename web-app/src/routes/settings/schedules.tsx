import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Icon } from '@/components/ui/icon'
import { ScheduleEditor } from '@/containers/schedules/ScheduleEditor'
import { ScheduleTaskRow } from '@/containers/schedules/ScheduleTaskRow'
import { useSchedules } from '@/containers/schedules/useSchedules'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ScheduledTask } from '@/lib/schedules'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.schedules as any)({
  component: SchedulesContent,
})

function SchedulesContent() {
  const { t } = useTranslation()
  const { views, loading, error, save, remove, setEnabled, runNow } = useSchedules()
  const [editing, setEditing] = useState<{ task: ScheduledTask | null } | null>(null)
  const [deleting, setDeleting] = useState<ScheduledTask | null>(null)

  return (
    <div className="flex h-full w-full flex-col">
      <SettingsPageHeader title={t('schedules:title')} />
      <SettingsPageBody
        title={t('schedules:title')}
        description={t('schedules:description')}
        actions={
          <Button onClick={() => setEditing({ task: null })} disabled={Boolean(error) && views.length === 0}>
            <Icon name="x-plus" size={14} />
            {t('schedules:newTask')}
          </Button>
        }
      >
        <Card>
          {error ? (
            <p role="alert" className="px-3.5 py-4 text-xs text-muted-foreground">
              {error}
            </p>
          ) : loading ? null : views.length === 0 ? (
            <div className="flex flex-col gap-1 px-3.5 py-5" data-testid="schedules-empty">
              <p className="text-[13px] font-medium text-foreground">{t('schedules:empty')}</p>
              <p className="text-xs text-muted-foreground">{t('schedules:emptyHint')}</p>
            </div>
          ) : (
            views.map((view) => (
              <ScheduleTaskRow
                key={view.task.id}
                view={view}
                onToggle={(enabled) => void setEnabled(view.task.id, enabled)}
                onRunNow={() => void runNow(view.task.id)}
                onEdit={() => setEditing({ task: view.task })}
                onDelete={() => setDeleting(view.task)}
              />
            ))
          )}
        </Card>
        <p className="text-xs text-muted-foreground">{t('schedules:unattendedNote')}</p>
      </SettingsPageBody>

      <ScheduleEditor
        open={editing !== null}
        task={editing?.task ?? null}
        onClose={() => setEditing(null)}
        onSave={save}
      />

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('schedules:list.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('schedules:list.deleteBody', { name: deleting?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const id = deleting?.id
                setDeleting(null)
                if (id) void remove(id)
              }}
            >
              {t('schedules:list.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
