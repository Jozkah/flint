import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'

import { useEffect, useState } from 'react'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { LogsDashboard } from '@/containers/LogViewer'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.appLogs as any)({
  component: LogsViewer,
})

/** Lines kept in view while following the log. */
const MAX_LOG_ENTRIES = 20000

function LogsViewer() {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const serviceHub = useServiceHub()

  useEffect(() => {
    // The viewer keeps the newest line in view while it follows the log.
    // One read at a time, no re-render when nothing was appended, and a
    // failed read (unreadable file) is logged rather than left unhandled.
    let reading = false
    // Where the next read starts: only appended lines are fetched, so the
    // 10 MB log is not re-read every poll (report-24 #8).
    let offset: number | undefined
    function updateLogs() {
      if (reading) return
      reading = true
      const app = serviceHub.app()
      const read =
        typeof app.readLogsSince === 'function'
          ? app.readLogsSince(offset).then((chunk) => {
              offset = chunk.offset
              return chunk
            })
          : app
              .readLogs()
              .then((entries) => ({ entries, offset: 0, reset: true }))
      read
        .then(({ entries, reset }) => {
          const next = entries.filter(Boolean) as LogEntry[]
          if (reset) {
            setLogs((prev) =>
              prev.length === next.length &&
              prev[prev.length - 1]?.timestamp ===
                next[next.length - 1]?.timestamp &&
              prev[prev.length - 1]?.message ===
                next[next.length - 1]?.message
                ? prev
                : next
            )
          } else if (next.length > 0) {
            setLogs((prev) => [...prev, ...next].slice(-MAX_LOG_ENTRIES))
          }
        })
        .catch((error) => console.error('Failed to read logs:', error))
        .finally(() => {
          reading = false
        })
    }
    updateLogs()

    // repeat each 3s while visible; catch up as soon as the page is shown
    const tick = () => {
      if (document.visibilityState !== 'hidden') updateLogs()
    }
    const intervalId = setInterval(tick, 3000)
    document.addEventListener('visibilitychange', tick)

    return () => {
      clearInterval(intervalId)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [serviceHub])

  return (
    <LogsDashboard
      title={t('logs:title')}
      description={t('logs:description')}
      fileName="app.log"
      logs={logs}
    />
  )
}
