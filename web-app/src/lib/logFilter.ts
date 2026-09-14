import type { LogEntry } from '@/services/app/types'

/** The level filters a log view offers, in the order they are shown. */
export const LOG_LEVEL_FILTERS = ['all', 'error', 'warn', 'info', 'debug'] as const
export type LogLevelFilter = (typeof LOG_LEVEL_FILTERS)[number]

/** The lines matching a level and a case-insensitive text query. */
export function filterLogs(
  logs: LogEntry[],
  query: string,
  level: LogLevelFilter
): LogEntry[] {
  const q = query.trim().toLowerCase()
  if (!q && level === 'all') return logs
  return logs.filter(
    (log) =>
      (level === 'all' || log.level === level) &&
      (!q ||
        log.message.toLowerCase().includes(q) ||
        (log.target ?? '').toLowerCase().includes(q))
  )
}
