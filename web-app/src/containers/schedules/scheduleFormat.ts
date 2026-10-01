import type { RunStatus, ScheduleSpec } from '@/lib/schedules'
import { formatTime } from './scheduleForm'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** Localised short weekday name; 0 = Sunday. */
export function weekdayName(day: number, locale?: string): string {
  // 2023-01-01 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2023, 0, 1 + day))
  )
}

/** "Every day at 09:00, 17:30" in the user's language. */
export function describeSchedule(spec: ScheduleSpec, t: Translate): string {
  if (spec.kind === 'cron') return t('schedules:summary.cron', { expr: spec.expr })
  const times = spec.times.map(formatTime).join(', ')
  if (spec.kind === 'weekly') {
    return t('schedules:summary.weekly', {
      days: spec.days.map((d) => weekdayName(d)).join(', '),
      times,
    })
  }
  return t(`schedules:summary.${spec.kind}`, { times })
}

export function formatWhen(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export const statusTone = (status: RunStatus): 'ok' | 'err' | 'warn' | 'neutral' | 'info' => {
  switch (status) {
    case 'succeeded':
      return 'ok'
    case 'failed':
      return 'err'
    case 'budget_stopped':
    case 'blocked':
      return 'warn'
    case 'running':
      return 'info'
    default:
      return 'neutral'
  }
}

export const tokenCount = (spend: { inputTokens: number; outputTokens: number }) =>
  spend.inputTokens + spend.outputTokens
