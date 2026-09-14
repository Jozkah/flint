import { useState, type Ref } from 'react'
import { Check, Copy, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { LogEntry } from '@/services/app/types'
import { cn } from '@/lib/utils'
import { LOG_LEVEL_FILTERS, type LogLevelFilter } from '@/lib/logFilter'

/** Level colours from the semantic tokens; everything else reads as neutral. */
function logLevelClass(level: string): string {
  switch (level) {
    case 'error':
      return 'text-destructive'
    case 'warn':
      return 'text-warning'
    case 'info':
      return 'text-ink-2'
    default:
      return 'text-muted-foreground'
  }
}

/** Time of day in UTC, 24-hour, as the log file records it. */
function formatLogTimestamp(timestamp: string | number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** The lines as plain text, the way they are shown. */
function logsAsText(logs: LogEntry[]): string {
  return logs
    .map(
      (log) =>
        `[${formatLogTimestamp(log.timestamp)}] ${log.level.toUpperCase()} ${log.message}`
    )
    .join('\n')
}

const LEVEL_LABEL_KEY: Record<LogLevelFilter, string> = {
  all: 'logs:levelAll',
  error: 'logs:levelError',
  warn: 'logs:levelWarn',
  info: 'logs:levelInfo',
  debug: 'logs:levelDebug',
}

/** Search and level filter above a log viewer. */
export function LogToolbar({
  query,
  onQueryChange,
  level,
  onLevelChange,
  shown,
  total,
}: {
  query: string
  onQueryChange: (query: string) => void
  level: LogLevelFilter
  onLevelChange: (level: LogLevelFilter) => void
  shown: number
  total: number
}) {
  const { t } = useTranslation()
  return (
    <div
      className="mb-2 flex min-w-0 flex-wrap items-center gap-2"
      data-testid="log-toolbar"
    >
      <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-card px-2.5 focus-within:outline-2 focus-within:outline-ring sm:max-w-xs pointer-coarse:h-11">
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t('logs:search')}
          aria-label={t('logs:search')}
          className="w-full min-w-0 bg-transparent text-base placeholder:text-muted-foreground focus:outline-none md:text-sm"
        />
      </label>
      <div
        role="group"
        aria-label={t('logs:filterLabel')}
        className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md bg-sunken p-0.5"
      >
        {LOG_LEVEL_FILTERS.map((value) => {
          const pressed = value === level
          return (
            <button
              key={value}
              type="button"
              aria-pressed={pressed}
              onClick={() => onLevelChange(value)}
              className={cn(
                'h-7 shrink-0 cursor-pointer rounded-[5px] px-2.5 text-[13px] font-medium transition-colors pointer-coarse:h-10',
                pressed
                  ? 'bg-card text-foreground shadow-[0_0_0_1px_var(--border)]'
                  : 'text-ink-2 hover:text-foreground'
              )}
            >
              {t(LEVEL_LABEL_KEY[value])}
            </button>
          )
        })}
      </div>
      <span
        className="ml-auto text-xs tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        {t('logs:shown', { shown, total })}
      </span>
    </div>
  )
}

/**
 * Log lines in mono on the code surface. Long lines scroll sideways inside the
 * panel rather than widening the page.
 */
export function LogViewer({
  logs,
  emptyText,
  ref,
}: {
  logs: LogEntry[]
  emptyText: string
  ref?: Ref<HTMLDivElement>
}) {
  return (
    <div
      ref={ref}
      data-testid="log-viewer"
      role="log"
      className="min-h-0 w-full min-w-0 flex-1 overflow-auto rounded-md border border-border bg-code font-mono text-xs leading-5 text-foreground select-text"
    >
      {logs.length === 0 ? (
        <div className="px-4 py-8 text-center font-sans text-sm text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        <div className="min-w-max py-2">
          {logs.map((log, index) => (
            <div
              key={index}
              className="flex gap-2 whitespace-pre px-3 hover:bg-accent"
            >
              <span className="tabular-nums text-muted-foreground">
                [{formatLogTimestamp(log.timestamp)}]
              </span>
              <span
                className={cn(
                  'w-11 shrink-0 font-semibold',
                  logLevelClass(log.level)
                )}
              >
                {log.level.toUpperCase()}
              </span>
              <span>{log.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Copies every line shown in the viewer. */
export function CopyLogsButton({ logs }: { logs: LogEntry[] }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logsAsText(logs))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy logs:', error)
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="pointer-coarse:h-11"
      disabled={logs.length === 0}
      onClick={() => void copy()}
      data-testid="copy-logs"
    >
      {copied ? <Check /> : <Copy />}
      {copied ? t('logs:copied') : t('logs:copy')}
    </Button>
  )
}
