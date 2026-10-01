/**
 * The editor's form model and its mapping to and from a stored task.
 *
 * The presets (every day, weekdays, certain days, each with several times)
 * compile to cron here exactly as `Schedule::to_cron` does in Rust, so the
 * "compiled to" line the editor shows is what the engine will run. The Rust
 * side still validates everything on save; this only keeps the page from
 * offering a task it already knows would be refused.
 */
import type {
  CatchUp,
  OnBlock,
  ScheduleSpec,
  ScheduledTask,
  TimeOfDay,
  WriteMode,
} from '@/lib/schedules'

export type Preset = 'daily' | 'weekdays' | 'weekly' | 'cron'

export type ScheduleForm = {
  preset: Preset
  /** `HH:MM`, 24-hour. */
  times: string[]
  /** 0 = Sunday .. 6 = Saturday. */
  days: number[]
  cron: string
}

export type TaskForm = {
  id: string
  name: string
  prompt: string
  schedule: ScheduleForm
  timezone: string
  model: string
  project: string
  profile: string
  allowTools: string[]
  write: WriteMode
  maxTurns: string
  maxTokens: string
  maxMinutes: string
  onBlock: OnBlock
  catchUp: CatchUp
  enabled: boolean
}

/** Mirrors the limits `Budgets::validate` enforces. */
export const LIMITS = {
  maxTurns: 200,
  maxTokens: 5_000_000,
  maxMinutes: 360,
} as const

export const DEFAULT_BUDGETS = { maxTurns: '20', maxTokens: '200000', maxMinutes: '15' }

/** Read-only tools a new task starts with. */
export const DEFAULT_TOOLS = ['read', 'ls', 'find', 'grep']

export const parseTime = (text: string): TimeOfDay | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  return hour < 24 && minute < 60 ? { hour, minute } : null
}

export const formatTime = ({ hour, minute }: TimeOfDay): string =>
  `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

const sortedTimes = (times: string[]): TimeOfDay[] =>
  times
    .map(parseTime)
    .filter((t): t is TimeOfDay => t !== null)
    .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute))

/** The cron expressions a form compiles to; one per distinct minute. */
export function formToCron(form: ScheduleForm): string[] {
  if (form.preset === 'cron') {
    const expr = form.cron.trim()
    return expr ? [expr] : []
  }
  const times = sortedTimes(form.times)
  if (times.length === 0) return []
  let dow = '*'
  if (form.preset === 'weekdays') dow = '1-5'
  if (form.preset === 'weekly') {
    const days = [...new Set(form.days)].sort((a, b) => a - b)
    if (days.length === 0) return []
    dow = days.join(',')
  }
  const byMinute = new Map<number, Set<number>>()
  for (const t of times) {
    if (!byMinute.has(t.minute)) byMinute.set(t.minute, new Set())
    byMinute.get(t.minute)!.add(t.hour)
  }
  return [...byMinute.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([minute, hours]) => {
      const h = [...hours].sort((a, b) => a - b).join(',')
      return `${minute} ${h} * * ${dow}`
    })
}

/** The stored schedule for a form, or `null` while the form cannot make one. */
export function formToSchedule(form: ScheduleForm): ScheduleSpec | null {
  if (form.preset === 'cron') {
    const expr = form.cron.trim()
    return expr ? { kind: 'cron', expr } : null
  }
  const times = sortedTimes(form.times)
  if (times.length === 0) return null
  if (form.preset === 'daily') return { kind: 'daily', times }
  if (form.preset === 'weekdays') return { kind: 'weekdays', times }
  const days = [...new Set(form.days)].sort((a, b) => a - b)
  return days.length ? { kind: 'weekly', days, times } : null
}

export function scheduleToForm(spec: ScheduleSpec): ScheduleForm {
  if (spec.kind === 'cron') {
    return { preset: 'cron', times: ['09:00'], days: [1, 2, 3, 4, 5], cron: spec.expr }
  }
  return {
    preset: spec.kind,
    times: spec.times.map(formatTime),
    days: spec.kind === 'weekly' ? [...spec.days] : [1, 2, 3, 4, 5],
    cron: '',
  }
}

/**
 * Switch the form to raw cron, starting from what the current preset compiles
 * to. Only possible when that is one expression; several times on different
 * minutes need several and cannot be written as one line.
 */
export function toCronForm(form: ScheduleForm): ScheduleForm | null {
  if (form.preset === 'cron') return form
  const compiled = formToCron(form)
  if (compiled.length > 1) return null
  return { ...form, preset: 'cron', cron: compiled[0] ?? '' }
}

export function newTaskForm(defaults: { timezone: string }): TaskForm {
  return {
    id: '',
    name: '',
    prompt: '',
    schedule: { preset: 'daily', times: ['09:00'], days: [1, 2, 3, 4, 5], cron: '' },
    timezone: defaults.timezone,
    model: '',
    project: '',
    profile: '',
    allowTools: [...DEFAULT_TOOLS],
    write: 'read_only',
    ...DEFAULT_BUDGETS,
    onBlock: 'continue',
    catchUp: 'once',
    enabled: true,
  }
}

export function taskToForm(task: ScheduledTask): TaskForm {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    schedule: scheduleToForm(task.schedule),
    timezone: task.timezone,
    model: task.model,
    project: task.project,
    profile: task.profile ?? '',
    allowTools: [...task.policy.allowTools],
    write: task.policy.write,
    maxTurns: String(task.budgets.maxTurns),
    maxTokens: String(task.budgets.maxTokens),
    maxMinutes: String(Math.max(1, Math.ceil(task.budgets.maxWallClockSecs / 60))),
    onBlock: task.onBlock,
    catchUp: task.catchUp,
    enabled: task.enabled,
  }
}

/** Field name to an i18n key under `schedules:errors`. */
export type FormErrors = Partial<Record<
  | 'name'
  | 'prompt'
  | 'model'
  | 'project'
  | 'times'
  | 'days'
  | 'cron'
  | 'timezone'
  | 'tools'
  | 'maxTurns'
  | 'maxTokens'
  | 'maxMinutes',
  string
>>

const wholeNumber = (text: string): number | null => {
  const trimmed = text.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null
}

export function validateForm(form: TaskForm): FormErrors {
  const errors: FormErrors = {}
  if (!form.name.trim()) errors.name = 'schedules:errors.nameRequired'
  if (!form.prompt.trim()) errors.prompt = 'schedules:errors.promptRequired'
  if (!form.model.trim()) errors.model = 'schedules:errors.modelRequired'
  if (!form.project.trim()) errors.project = 'schedules:errors.folderRequired'
  if (!form.timezone.trim()) errors.timezone = 'schedules:errors.zoneRequired'
  const s = form.schedule
  if (s.preset === 'cron') {
    if (!s.cron.trim()) errors.cron = 'schedules:errors.cronRequired'
  } else {
    if (s.times.length === 0) errors.times = 'schedules:errors.timesRequired'
    else if (s.times.some((t) => parseTime(t) === null))
      errors.times = 'schedules:errors.timeInvalid'
    if (s.preset === 'weekly' && s.days.length === 0)
      errors.days = 'schedules:errors.daysRequired'
  }
  if (form.allowTools.length === 0) errors.tools = 'schedules:errors.toolsRequired'
  const turns = wholeNumber(form.maxTurns)
  if (turns === null || turns < 1 || turns > LIMITS.maxTurns)
    errors.maxTurns = 'schedules:errors.turnsRange'
  const tokens = wholeNumber(form.maxTokens)
  if (tokens === null || tokens < 1 || tokens > LIMITS.maxTokens)
    errors.maxTokens = 'schedules:errors.tokensRange'
  const minutes = wholeNumber(form.maxMinutes)
  if (minutes === null || minutes < 1 || minutes > LIMITS.maxMinutes)
    errors.maxMinutes = 'schedules:errors.minutesRange'
  return errors
}

/** The task to save, or the errors that stop the form from making one. */
export function formToTask(
  form: TaskForm
): { task: ScheduledTask } | { errors: FormErrors } {
  const errors = validateForm(form)
  const schedule = formToSchedule(form.schedule)
  if (Object.keys(errors).length > 0 || !schedule) {
    return { errors }
  }
  return {
    task: {
      id: form.id,
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      schedule,
      timezone: form.timezone.trim(),
      model: form.model.trim(),
      project: form.project.trim(),
      profile: form.profile.trim() || null,
      policy: { allowTools: [...form.allowTools], write: form.write },
      budgets: {
        maxTurns: Number(form.maxTurns),
        maxTokens: Number(form.maxTokens),
        maxWallClockSecs: Number(form.maxMinutes) * 60,
      },
      onBlock: form.onBlock,
      catchUp: form.catchUp,
      enabled: form.enabled,
    },
  }
}
