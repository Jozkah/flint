import { useState, type Ref } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { LogEntry } from '@/services/app/types'
import { cn } from '@/lib/utils'

/** Level colours from the semantic tokens; unknown levels read as muted. */
function logLevelClass(level: string): string {
  switch (level) {
    case 'error':
      return 'text-destructive'
    case 'warn':
      return 'text-warning'
    case 'info':
      return 'text-brand-text'
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

/**
 * Log lines in mono on a sunken panel. Long lines scroll sideways inside the
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
      className="min-h-0 w-full flex-1 overflow-auto rounded-lg border border-border bg-sunken font-mono text-xs leading-5 text-foreground select-text"
    >
      {logs.length === 0 ? (
        <div className="px-4 py-8 text-center font-sans text-sm text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        <div className="min-w-max py-2">
          {logs.map((log, index) => (
            <div key={index} className="flex gap-2 whitespace-pre px-3">
              <span className="tabular-nums text-muted-foreground">
                [{formatLogTimestamp(log.timestamp)}]
              </span>
              <span className={cn('font-semibold', logLevelClass(log.level))}>
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
