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
    function updateLogs() {
      serviceHub
        .app()
        .readLogs()
        .then((logData) => {
          setLogs(logData.filter(Boolean) as LogEntry[])
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
