import { useEffect, useState } from 'react'
import { useServiceHub } from '@/hooks/useServiceHub'
import type { LogEntry } from '@/services/app/types'

const SERVER_LOG_TARGET = 'app_lib::core::server::proxy'
const LOG_EVENT_NAME = 'log://log'

/** The most lines kept in memory; older lines are dropped first. */
export const MAX_SERVER_LOG_LINES = 2000

const cap = (logs: LogEntry[]): LogEntry[] =>
  logs.length > MAX_SERVER_LOG_LINES
    ? logs.slice(logs.length - MAX_SERVER_LOG_LINES)
    : logs

const ids = new WeakMap<LogEntry, number>()
let nextId = 0
/** A key that stays with a line as the capped list shifts. */
export const logKey = (log: LogEntry): number => {
  let id = ids.get(log)
  if (id === undefined) {
    id = nextId++
    ids.set(log, id)
  }
  return id
}

/**
 * The local API server's log: the file's history merged with live lines
 * (lines that arrive before the file is read are kept, not overwritten),
 * capped, with the listener released even when it resolves after unmount.
 */
export function useServerLogs(): LogEntry[] {
  const serviceHub = useServiceHub()
  const [logs, setLogs] = useState<LogEntry[]>([])

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    serviceHub
      .app()
      .readLogs()
      .then((logData) => {
        if (cancelled) return
        const history = (logData ?? []).filter(
          (log) => log?.target === SERVER_LOG_TARGET
        ) as LogEntry[]
        setLogs((live) => cap([...history, ...live]))
      })
      .catch((error) => {
        console.error('Failed to read logs:', error)
      })

    serviceHub
      .events()
      .listen(LOG_EVENT_NAME, (event) => {
        const { message } = event.payload as { message: string }
        const log: LogEntry | undefined = serviceHub.app().parseLogLine(message)
        if (log?.target === SERVER_LOG_TARGET) {
          setLogs((prev) => cap([...prev, log]))
        }
      })
      .then((unsub) => {
        if (cancelled) unsub()
        else unsubscribe = unsub
      })
      .catch((error) => {
        console.error('Failed to listen for logs:', error)
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [serviceHub])

  return logs
}
