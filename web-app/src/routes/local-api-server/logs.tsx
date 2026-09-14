import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'

import { useEffect, useMemo, useState, useRef } from 'react'
import { ScrollText } from 'lucide-react'
import { useServiceHub } from '@/hooks/useServiceHub'
import type { LogEntry } from '@/services/app/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { SystemPageHeader } from '@/containers/SystemPageHeader'
import { CopyLogsButton, LogToolbar, LogViewer } from '@/containers/LogViewer'
import { filterLogs, type LogLevelFilter } from '@/lib/logFilter'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.localApiServerlogs as any)({
  component: LogsViewer,
})

const SERVER_LOG_TARGET = 'app_lib::core::server::proxy'
const LOG_EVENT_NAME = 'log://log'

function LogsViewer() {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState<LogLevelFilter>('all')
  const logsContainerRef = useRef<HTMLDivElement>(null)
  const serviceHub = useServiceHub()

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
  }, [serviceHub])

  // Function to scroll to the bottom of the logs container
  const scrollToBottom = () => {
    if (logsContainerRef.current) {
      const { scrollHeight, clientHeight } = logsContainerRef.current
      logsContainerRef.current.scrollTop = scrollHeight - clientHeight
    }
  }

  const shown = useMemo(
    () => filterLogs(logs, query, level),
    [logs, query, level]
  )

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background">
      <SystemPageHeader
        title={t('logs:serverTitle')}
        icon={<ScrollText className="size-4" />}
        actions={<CopyLogsButton logs={shown} />}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-3 md:p-4">
        {logs.length > 0 && (
          <LogToolbar
            query={query}
            onQueryChange={setQuery}
            level={level}
            onLevelChange={setLevel}
            shown={shown.length}
            total={logs.length}
          />
        )}
        <LogViewer
          ref={logsContainerRef}
          logs={shown}
          emptyText={logs.length === 0 ? t('logs:noLogs') : t('logs:noMatch')}
        />
      </div>
    </div>
  )
}
