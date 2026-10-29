import { useEffect, useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { RoomModelSelect, selectClassName } from '@/containers/rooms/RoomModelSelect'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  schedulePreview,
  scheduleTimeZones,
  scheduleTools,
  type ScheduleTool,
  type ScheduledTask,
  type WriteMode,
} from '@/lib/schedules'
import { errorText } from '@/lib/errorText'
import {
  formToSchedule,
  formToTask,
  neverRunsWarnings,
  newTaskForm,
  taskToForm,
  validateForm,
  type FormErrors,
  type TaskForm,
} from './scheduleForm'
import {
  Field,
  ScheduleBudgets,
  ScheduleRunPolicy,
  ScheduleToolsField,
  ScheduleWhenSection,
} from './ScheduleEditorSections'

type Props = {
  open: boolean
  /** The task being edited, or `null` for a new one. */
  task: ScheduledTask | null
  onClose: () => void
  /** Resolves true when the task was saved. */
  onSave: (task: ScheduledTask) => Promise<boolean>
}

const localZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** `provider/model` back into the provider and model the picker selects. */
function modelRef(value: string, providers: { provider: string }[]) {
  const provider = providers.find((p) => value.startsWith(`${p.provider}/`))
  if (!provider) return null
  return { provider: provider.provider, id: value.slice(provider.provider.length + 1) }
}

export function ScheduleEditor({ open, task, onClose, onSave }: Props) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const uid = useId()
  const providers = useModelProvider((s) => s.providers)
  const [form, setForm] = useState<TaskForm>(() => newTaskForm({ timezone: localZone() }))
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [zones, setZones] = useState<string[]>([])
  const [tools, setTools] = useState<ScheduleTool[]>([])
  const [preview, setPreview] = useState<{
    fires: string[]
    error: string | null
    neverFires: boolean
  }>({
    fires: [],
    error: null,
    neverFires: false,
  })

  // A fresh form each time the dialog opens, for the task it is opened on.
  useEffect(() => {
    if (!open) return
    setForm(task ? taskToForm(task) : newTaskForm({ timezone: localZone() }))
    setSubmitted(false)
    setSaving(false)
  }, [open, task])

  useEffect(() => {
    if (!open) return
    let live = true
    void scheduleTimeZones().then((z) => live && setZones(z)).catch(() => {})
    void scheduleTools().then((x) => live && setTools(x)).catch(() => {})
    return () => {
      live = false
    }
  }, [open])

  // The next five runs, from what is in the form right now (not what is saved).
  useEffect(() => {
    if (!open) return
    const spec = formToSchedule(form.schedule)
    if (!spec || !form.timezone.trim()) {
      setPreview({ fires: [], error: null, neverFires: false })
      return
    }
    let live = true
    const timer = setTimeout(() => {
      schedulePreview(spec, form.timezone.trim(), 5)
        .then(
          (p) =>
            live && setPreview({ fires: p.fires, error: null, neverFires: p.neverFires })
        )
        .catch(
          (e) =>
            live && setPreview({ fires: [], error: errorText(e), neverFires: false })
        )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, form.schedule, form.timezone])

  const errors: FormErrors = useMemo(() => (submitted ? validateForm(form) : {}), [submitted, form])
  const err = (key: keyof FormErrors) => (errors[key] ? t(errors[key]!) : undefined)
  const patch = (p: Partial<TaskForm>) => setForm((f) => ({ ...f, ...p }))
  const patchSchedule = (p: Partial<TaskForm['schedule']>) =>
    setForm((f) => ({ ...f, schedule: { ...f.schedule, ...p } }))


  const chooseFolder = async () => {
    try {
      const picked = await serviceHub.dialog().open({ directory: true })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (path) patch({ project: path })
    } catch {
      // Cancelling the dialog is not an error.
    }
  }

  const submit = async () => {
    setSubmitted(true)
    const result = formToTask(form)
    if (!('task' in result)) return
    setSaving(true)
    const ok = await onSave(result.task)
    setSaving(false)
    if (ok) onClose()
  }

  const model = modelRef(form.model, providers)
  const section = { uid, form, errors, err, patch }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="schedule-editor">
        <DialogHeader>
          <DialogTitle>
            {task ? t('schedules:editor.titleEdit') : t('schedules:editor.titleNew')}
          </DialogTitle>
          <DialogDescription>{t('schedules:unattendedNote')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field label={t('schedules:editor.name')} htmlFor={`${uid}-name`} error={err('name')}>
            <Input
              id={`${uid}-name`}
              value={form.name}
              placeholder={t('schedules:editor.namePlaceholder')}
              aria-invalid={errors.name ? true : undefined}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>

          <Field
            label={t('schedules:editor.prompt')}
            htmlFor={`${uid}-prompt`}
            hint={t('schedules:editor.promptHint')}
            error={err('prompt')}
          >
            <Textarea
              id={`${uid}-prompt`}
              className="min-h-24"
              value={form.prompt}
              placeholder={t('schedules:editor.promptPlaceholder')}
              aria-invalid={errors.prompt ? true : undefined}
              onChange={(e) => patch({ prompt: e.target.value })}
            />
          </Field>

          <ScheduleWhenSection
            {...section}
            patchSchedule={patchSchedule}
            zones={zones}
            preview={preview}
          />

          <Field label={t('schedules:editor.model')} htmlFor={`${uid}-model`} error={err('model')}>
            <RoomModelSelect
              id={`${uid}-model`}
              value={model}
              invalid={Boolean(errors.model)}
              onChange={(ref) => patch({ model: `${ref.provider}/${ref.id}` })}
            />
          </Field>

          <Field
            label={t('schedules:editor.folder')}
            hint={t('schedules:editor.folderHint')}
            error={err('project')}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  selectClassName,
                  'flex items-center truncate font-mono text-xs',
                  !form.project && 'text-muted-foreground'
                )}
                title={form.project}
              >
                {form.project || '-'}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => void chooseFolder()}>
                {form.project ? t('schedules:editor.changeFolder') : t('schedules:editor.chooseFolder')}
              </Button>
            </div>
          </Field>

          <Field
            label={t('schedules:editor.profile')}
            htmlFor={`${uid}-profile`}
            hint={t('schedules:editor.profileHint')}
          >
            <Input
              id={`${uid}-profile`}
              value={form.profile}
              onChange={(e) => patch({ profile: e.target.value })}
            />
          </Field>

          <ScheduleToolsField {...section} tools={tools} />

          <Field
            label={t('schedules:editor.write')}
            hint={
              form.write === 'worktree'
                ? t('schedules:editor.writeWorktreeHint')
                : t('schedules:editor.writeReadOnlyHint')
            }
          >
            <Segmented<WriteMode>
              aria-label={t('schedules:editor.write')}
              options={[
                { value: 'read_only', label: t('schedules:editor.writeReadOnly') },
                { value: 'worktree', label: t('schedules:editor.writeWorktree') },
              ]}
              value={form.write}
              onValueChange={(write) => patch({ write })}
            />
          </Field>

          <ScheduleBudgets {...section} />

          <ScheduleRunPolicy {...section} />

          {neverRunsWarnings(form, preview.neverFires).map((key) => (
            <p
              key={key}
              role="status"
              data-testid="never-runs-warning"
              className="rounded-md border-[0.8px] border-border bg-card px-3 py-2 text-xs text-warning"
            >
              {t(key)}
            </p>
          ))}

          <div className="flex items-center justify-between">
            <Label htmlFor={`${uid}-enabled`}>{t('schedules:editor.enabled')}</Label>
            <Switch
              id={`${uid}-enabled`}
              checked={form.enabled}
              onCheckedChange={(enabled) => patch({ enabled })}
            />
          </div>
        </div>

        <DialogFooter className={STICKY_DIALOG_FOOTER}>
          <Button variant="ghost" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? t('schedules:editor.saving') : t('schedules:editor.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
