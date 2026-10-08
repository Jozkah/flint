import { useEffect, useRef } from 'react'
import { useServerLogs, logKey } from '@/hooks/useServerLogs'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

export function LogViewer() {
  const { t } = useTranslation()
  const logs = useServerLogs()
  const logsContainerRef = useRef<HTMLDivElement>(null)

  // Newest first: the latest line is at the top, so follow it there.
  useEffect(() => {
    const el = logsContainerRef.current
    if (el) el.scrollTop = 0
  }, [logs])

    // Format timestamp to be more readable
    const formatTimestamp = (timestamp: string | number) => {
      const date = new Date(timestamp)
      return date.toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: 'UTC',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    }

  // The design's plain log: time, level and message on one wrapping line;
  // an error line is red throughout, a warning's level amber.
  return (
    <div
      ref={logsContainerRef}
      className="h-full overflow-x-hidden overflow-y-auto px-3 py-2 font-mono text-xs leading-[1.7] text-fg-2 [scrollbar-width:thin]"
    >
      {logs.length === 0 ? (
        <div className="py-4 text-center font-sans text-muted-foreground">
          {t('logs:noLogs')}
        </div>
      ) : (
        [...logs].reverse().map((log) => (
          <div
            key={logKey(log)}
            className={cn(
              'break-words whitespace-pre-wrap',
              log.level === 'error' && 'text-destructive',
              log.level === 'debug' && 'text-muted-foreground'
            )}
          >
            <span className="text-subtle-foreground">
              [{formatTimestamp(log.timestamp)}]
            </span>{' '}
            <b
              className={cn(
                'font-bold',
                log.level === 'warn' && 'text-warning'
              )}
            >
              {log.level.toUpperCase()}
            </b>{' '}
            {log.message}
          </div>
        ))
      )}
    </div>
  )
}
