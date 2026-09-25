import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'

import { useEffect, useState } from 'react'
import { useServiceHub } from '@/hooks/useServiceHub'
import type { LogEntry } from '@/services/app/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { LogsDashboard } from '@/containers/LogViewer'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.localApiServerlogs as any)({
  component: LogsViewer,
})

const SERVER_LOG_TARGET = 'app_lib::core::server::proxy'
const LOG_EVENT_NAME = 'log://log'

function LogsViewer() {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const serviceHub = useServiceHub()

  useEffect(() => {
    serviceHub.app().readLogs().then((logData) => {
      const logs = logData
        .filter((log) => log?.target === SERVER_LOG_TARGET)
        .filter(Boolean) as LogEntry[]
      setLogs(logs)
    })
    let unsubscribe = () => {}
    serviceHub.events().listen(LOG_EVENT_NAME, (event) => {
      const { message } = event.payload as { message: string }
      const log: LogEntry | undefined = serviceHub.app().parseLogLine(message)
      if (log?.target === SERVER_LOG_TARGET) {
        // The viewer keeps the newest line in view while it follows.
        setLogs((prevLogs) => [...prevLogs, log])
      }
    }).then((unsub) => {
      unsubscribe = unsub
    })
    return () => {
      unsubscribe()
    }
  }, [serviceHub])

  return (
    <LogsDashboard
      title={t('logs:serverTitle')}
      description={t('logs:serverDescription')}
      fileName="server.log"
      logs={logs}
    />
  )
}
