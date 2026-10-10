import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
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
  type CatchUp,
  type OnBlock,
  type ScheduleTool,
  type ScheduledTask,
  type WriteMode,
} from '@/lib/schedules'
import { errorText } from '@/lib/errorText'
import { formatWhen, weekdayName } from './scheduleFormat'
import {
  formToCron,
  formToSchedule,
  formToTask,
  neverRunsWarnings,
  newTaskForm,
  taskToForm,
  toCronForm,
  validateForm,
  type FormErrors,
  type Preset,
  type TaskForm,
} from './scheduleForm'
import { TimeChips } from './TimeChips'
import { Select } from '@/components/ui/select'

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

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  error?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
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
  const [preview, setPreview] = useState<{ fires: string[]; error: string | null }>({
    fires: [],
    error: null,
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
      setPreview({ fires: [], error: null })
      return
    }
    let live = true
    const timer = setTimeout(() => {
      schedulePreview(spec, form.timezone.trim(), 5)
        .then((fires) => live && setPreview({ fires, error: null }))
        .catch((e) => live && setPreview({ fires: [], error: errorText(e) }))
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

  const compiled = formToCron(form.schedule)
  const cronForm = toCronForm(form.schedule)

  const chooseFolder = async () => {
    try {
      const picked = await serviceHub.dialog().open({ directory: true })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (path) patch({ project: path })
    } catch {
      // Cancelling the dialog is not an error.
    }
  }

  const toggleTool = (name: string) =>
    patch({
      allowTools: form.allowTools.includes(name)
        ? form.allowTools.filter((x) => x !== name)
        : [...form.allowTools, name],
    })

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
  const presetOptions: { value: Preset; label: string }[] = [
    { value: 'daily', label: t('schedules:editor.presets.daily') },
    { value: 'weekdays', label: t('schedules:editor.presets.weekdays') },
    { value: 'weekly', label: t('schedules:editor.presets.weekly') },
    { value: 'cron', label: t('schedules:editor.presets.cron') },
  ]

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

          <section className="flex flex-col gap-3 rounded-lg border-[0.8px] border-border p-3">
            <Label>{t('schedules:editor.when')}</Label>
            <Segmented<Preset>
              aria-label={t('schedules:editor.when')}
              options={presetOptions}
              value={form.schedule.preset}
              onValueChange={(preset) => {
                if (preset === 'cron') {
                  const next = toCronForm(form.schedule)
                  if (next) patchSchedule(next)
                  else patchSchedule({ preset: 'cron', cron: compiled[0] ?? '' })
                } else {
                  patchSchedule({ preset })
                }
              }}
            />

            {form.schedule.preset === 'cron' ? (
              <Field
                label={t('schedules:editor.cron')}
                htmlFor={`${uid}-cron`}
                hint={t('schedules:editor.cronHint')}
                error={err('cron')}
              >
                <Input
                  id={`${uid}-cron`}
                  className="font-mono"
                  value={form.schedule.cron}
                  placeholder="0 9 * * 1-5"
                  aria-invalid={errors.cron ? true : undefined}
                  onChange={(e) => patchSchedule({ cron: e.target.value })}
                />
              </Field>
            ) : (
              <>
                {form.schedule.preset === 'weekly' && (
                  <Field label={t('schedules:editor.days')} error={err('days')}>
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('schedules:editor.days')}>
                      {[1, 2, 3, 4, 5, 6, 0].map((day) => {
                        const on = form.schedule.days.includes(day)
                        return (
                          <button
                            key={day}
                            type="button"
                            aria-pressed={on}
                            className={cn(
                              'h-7 min-w-11 cursor-pointer rounded-md border-[0.8px] px-2 text-xs',
                              on
                                ? 'border-border-strong bg-card font-medium text-foreground'
                                : 'border-border text-muted-foreground hover:text-foreground'
                            )}
                            onClick={() =>
                              patchSchedule({
                                days: on
                                  ? form.schedule.days.filter((d) => d !== day)
                                  : [...form.schedule.days, day],
                              })
                            }
                          >
                            {weekdayName(day)}
                          </button>
                        )
                      })}
                    </div>
                  </Field>
                )}
                <Field label={t('schedules:editor.times')} htmlFor={`${uid}-time`} error={err('times')}>
                  <TimeChips
                    id={`${uid}-time`}
                    times={form.schedule.times}
                    invalid={Boolean(errors.times)}
                    onChange={(times) => patchSchedule({ times })}
                  />
                </Field>
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <span>
                    {t('schedules:editor.cronCompiled')}{' '}
                    <code className="font-mono text-secondary-foreground" data-testid="compiled-cron">
                      {compiled.join('  |  ') || '-'}
                    </code>
                  </span>
                  <span>
                    <button
                      type="button"
                      className="cursor-pointer text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!cronForm}
                      onClick={() => cronForm && patchSchedule(cronForm)}
                    >
                      {t('schedules:editor.editAsCron')}
                    </button>
                    {!cronForm && <> - {t('schedules:editor.cronNeedsOne')}</>}
                  </span>
                </div>
              </>
            )}

            <Field label={t('schedules:editor.timeZone')} htmlFor={`${uid}-zone`} error={err('timezone')}>
              <Input
                id={`${uid}-zone`}
                list={`${uid}-zones`}
                value={form.timezone}
                aria-invalid={errors.timezone ? true : undefined}
                onChange={(e) => patch({ timezone: e.target.value })}
              />
              <datalist id={`${uid}-zones`}>
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Field>

            <div aria-live="polite" data-testid="next-fires">
              <p className="text-xs font-medium text-foreground">{t('schedules:editor.nextFires')}</p>
              {preview.error ? (
                <p className="text-xs text-destructive">{preview.error}</p>
              ) : preview.fires.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('schedules:editor.nextFiresNone')}</p>
              ) : (
                <ol className="text-xs text-muted-foreground">
                  {preview.fires.map((f) => (
                    <li key={f}>{formatWhen(f)}</li>
                  ))}
                </ol>
              )}
            </div>
          </section>

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

          <Field label={t('schedules:editor.tools')} hint={t('schedules:editor.toolsHint')} error={err('tools')}>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5" role="group" aria-label={t('schedules:editor.tools')}>
              {tools.map((tool) => (
                <label
                  key={tool.name}
                  className="inline-flex cursor-pointer items-center gap-1.5 font-mono text-xs"
                  title={
                    tool.capability === 'write' || tool.capability === 'exec'
                      ? t('schedules:editor.toolNeedsApproval')
                      : undefined
                  }
                >
                  <input
                    type="checkbox"
                    checked={form.allowTools.includes(tool.name)}
                    onChange={() => toggleTool(tool.name)}
                  />
                  {tool.name}
                  {(tool.capability === 'write' || tool.capability === 'exec') && (
                    <span className="text-[10px] text-warning">{tool.capability}</span>
                  )}
                </label>
              ))}
            </div>
          </Field>

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

          <section className="flex flex-col gap-2">
            <div>
              <Label>{t('schedules:editor.budgets')}</Label>
              <p className="mt-1 text-xs text-muted-foreground">{t('schedules:editor.budgetsHint')}</p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label={t('schedules:editor.maxTurns')} htmlFor={`${uid}-turns`} error={err('maxTurns')}>
                <Input
                  id={`${uid}-turns`}
                  inputMode="numeric"
                  value={form.maxTurns}
                  aria-invalid={errors.maxTurns ? true : undefined}
                  onChange={(e) => patch({ maxTurns: e.target.value })}
                />
              </Field>
              <Field label={t('schedules:editor.maxTokens')} htmlFor={`${uid}-tokens`} error={err('maxTokens')}>
                <Input
                  id={`${uid}-tokens`}
                  inputMode="numeric"
                  value={form.maxTokens}
                  aria-invalid={errors.maxTokens ? true : undefined}
                  onChange={(e) => patch({ maxTokens: e.target.value })}
                />
              </Field>
              <Field label={t('schedules:editor.maxMinutes')} htmlFor={`${uid}-minutes`} error={err('maxMinutes')}>
                <Input
                  id={`${uid}-minutes`}
                  inputMode="numeric"
                  value={form.maxMinutes}
                  aria-invalid={errors.maxMinutes ? true : undefined}
                  onChange={(e) => patch({ maxMinutes: e.target.value })}
                />
              </Field>
              <Field
                label={t('schedules:editor.maxCostUsd')}
                htmlFor={`${uid}-cost`}
                error={err('maxCostUsd')}
              >
                <Input
                  id={`${uid}-cost`}
                  inputMode="decimal"
                  value={form.maxCostUsd}
                  placeholder={t('schedules:editor.maxCostUsdPlaceholder')}
                  aria-invalid={errors.maxCostUsd ? true : undefined}
                  onChange={(e) => patch({ maxCostUsd: e.target.value })}
                />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">{t('schedules:editor.maxCostUsdHint')}</p>
          </section>

          <div className="grid gap-3 @min-[32rem]:grid-cols-2 sm:grid-cols-2">
            <Field label={t('schedules:editor.onBlock')} htmlFor={`${uid}-onblock`}>
              <Select
                id={`${uid}-onblock`}
                className={selectClassName}
                value={form.onBlock}
                onChange={(e) => patch({ onBlock: e.target.value as OnBlock })}
              >
                <option value="continue">{t('schedules:editor.onBlockContinue')}</option>
                <option value="end">{t('schedules:editor.onBlockEnd')}</option>
              </Select>
            </Field>
            <Field label={t('schedules:editor.catchUp')} htmlFor={`${uid}-catchup`}>
              <Select
                id={`${uid}-catchup`}
                className={selectClassName}
                value={form.catchUp}
                onChange={(e) => patch({ catchUp: e.target.value as CatchUp })}
              >
                <option value="skip">{t('schedules:editor.catchUpSkip')}</option>
                <option value="once">{t('schedules:editor.catchUpOnce')}</option>
                <option value="all_capped">{t('schedules:editor.catchUpAllCapped')}</option>
              </Select>
            </Field>
          </div>

          {neverRunsWarnings(form, preview.error).map((key) => (
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
