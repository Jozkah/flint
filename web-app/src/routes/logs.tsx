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

function LogsViewer() {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const serviceHub = useServiceHub()

  useEffect(() => {
    // The viewer keeps the newest line in view while it follows the log.
    // One read at a time, no re-render when nothing was appended, and a
    // failed read (unreadable file) is logged rather than left unhandled.
    let reading = false
    function updateLogs() {
      if (reading) return
      reading = true
      serviceHub
        .app()
        .readLogs()
        .then((logData) => {
          const next = logData.filter(Boolean) as LogEntry[]
          setLogs((prev) =>
            prev.length === next.length &&
            prev[prev.length - 1]?.timestamp ===
              next[next.length - 1]?.timestamp &&
            prev[prev.length - 1]?.message === next[next.length - 1]?.message
              ? prev
              : next
          )
        })
        .catch((error) => console.error('Failed to read logs:', error))
        .finally(() => {
          reading = false
        })
    }
    updateLogs()

    // repeat action each 3s
    const intervalId = setInterval(() => updateLogs(), 3000)

    return () => {
      clearInterval(intervalId)
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
