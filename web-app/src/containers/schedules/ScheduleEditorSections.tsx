import { type ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Select } from '@/components/ui/select'
import { selectClassName } from '@/containers/rooms/RoomModelSelect'
import type { CatchUp, OnBlock, ScheduleTool } from '@/lib/schedules'
import { Segmented } from '@/components/ui/segmented'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { formatWhen, weekdayName } from './scheduleFormat'
import {
  formToCron,
  toCronForm,
  type FormErrors,
  type Preset,
  type TaskForm,
} from './scheduleForm'
import { TimeChips } from './TimeChips'

export function Field({
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

/** What the schedule editor's sections share. */
export type EditorSectionProps = {
  uid: string
  form: TaskForm
  errors: FormErrors
  err: (key: keyof FormErrors) => string | undefined
  patch: (p: Partial<TaskForm>) => void
}

/** When the task runs: preset, days, times or cron, zone, and the next runs. */
export function ScheduleWhenSection({
  uid,
  form,
  errors,
  err,
  patch,
  patchSchedule,
  zones,
  preview,
}: EditorSectionProps & {
  patchSchedule: (p: Partial<TaskForm['schedule']>) => void
  zones: string[]
  preview: { fires: string[]; error: string | null }
}) {
  const { t, i18n } = useTranslation()
  const compiled = formToCron(form.schedule)
  const cronForm = toCronForm(form.schedule)
  const presetOptions: { value: Preset; label: string }[] = [
    { value: 'daily', label: t('schedules:editor.presets.daily') },
    { value: 'weekdays', label: t('schedules:editor.presets.weekdays') },
    { value: 'weekly', label: t('schedules:editor.presets.weekly') },
    { value: 'cron', label: t('schedules:editor.presets.cron') },
  ]

  return (
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
                      {weekdayName(day, i18n?.language)}
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
              <li key={f}>{formatWhen(f, i18n?.language)}</li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}

/** The run's budgets: turns, tokens, minutes and cost. */
export function ScheduleBudgets({ uid, form, errors, err, patch }: EditorSectionProps) {
  const { t } = useTranslation()
  return (
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
  )
}

/** Which tools the task may use; write and exec ones are marked. */
export function ScheduleToolsField({
  form,
  err,
  patch,
  tools,
}: EditorSectionProps & { tools: ScheduleTool[] }) {
  const { t } = useTranslation()
  const toggleTool = (name: string) =>
    patch({
      allowTools: form.allowTools.includes(name)
        ? form.allowTools.filter((x) => x !== name)
        : [...form.allowTools, name],
    })
  return (
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
            <Checkbox
              checked={form.allowTools.includes(tool.name)}
              onChange={() => toggleTool(tool.name)}
            />
            {tool.name}
            {(tool.capability === 'write' || tool.capability === 'exec') && (
              <span className="text-[length:calc(var(--ui-font-base)*0.625)] text-warning">{tool.capability}</span>
            )}
          </label>
        ))}
      </div>
    </Field>
  )
}

/** What a run does when blocked, and how missed runs catch up. */
export function ScheduleRunPolicy({ uid, form, patch }: EditorSectionProps) {
  const { t } = useTranslation()
  return (
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
  )
}
