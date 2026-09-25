import { useEffect, useState, useRef, useCallback } from 'react'
import { useServiceHub } from '@/hooks/useServiceHub'
import type { LogEntry } from '@/services/app/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

const SERVER_LOG_TARGET = 'app_lib::core::server::proxy'
const LOG_EVENT_NAME = 'log://log'

export function LogViewer() {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const logsContainerRef = useRef<HTMLDivElement>(null)
  const serviceHub = useServiceHub()

  const scrollToBottom = useCallback(() => {
    const el = logsContainerRef.current
    if (el) {
      // Newest first: the latest line is at the top.
      el.scrollTop = 0
    }
  }, [])

  // Initial scroll to bottom when logs are loaded
  useEffect(() => {
      serviceHub.app().readLogs().then((logData) => {
        const logs = logData
          .filter((log) => log?.target === SERVER_LOG_TARGET)
          .filter(Boolean) as LogEntry[]
        setLogs(logs)

        // Scroll to bottom after initial logs are loaded
        setTimeout(() => {
          scrollToBottom()
        }, 100)
      })
      let unsubscribe = () => {}
      serviceHub.events().listen(LOG_EVENT_NAME, (event) => {
        const { message } = event.payload as { message: string }
        const log: LogEntry | undefined = serviceHub.app().parseLogLine(message)
        if (log?.target === SERVER_LOG_TARGET) {
          setLogs((prevLogs) => {
            const newLogs = [...prevLogs, log]
            // Schedule scroll to bottom after state update
            setTimeout(() => {
              scrollToBottom()
            }, 0)
            return newLogs
          })
        }
      }).then((unsub) => {
        unsubscribe = unsub
      })
      return () => {
        unsubscribe()
      }
    }, [serviceHub, scrollToBottom])

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
        [...logs].reverse().map((log, index) => (
          <div
            key={index}
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
