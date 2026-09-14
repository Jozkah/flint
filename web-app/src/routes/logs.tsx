import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'

import { useEffect, useMemo, useState, useRef } from 'react'
import { ScrollText } from 'lucide-react'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { SystemPageHeader } from '@/containers/SystemPageHeader'
import { CopyLogsButton, LogToolbar, LogViewer } from '@/containers/LogViewer'
import { filterLogs, type LogLevelFilter } from '@/lib/logFilter'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.appLogs as any)({
  component: LogsViewer,
})

function LogsViewer() {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState<LogLevelFilter>('all')
  const logsContainerRef = useRef<HTMLDivElement>(null)
  const serviceHub = useServiceHub()

  useEffect(() => {
    let lastLogsLength = 0
    function updateLogs() {
      serviceHub
        .app()
        .readLogs()
        .then((logData) => {
          let needScroll = false
          const filteredLogs = logData.filter(Boolean) as LogEntry[]
          if (filteredLogs.length > lastLogsLength) needScroll = true

          lastLogsLength = filteredLogs.length
          setLogs(filteredLogs)

          // Scroll to bottom after initial logs are loaded
          if (needScroll) setTimeout(() => scrollToBottom(), 100)
        })
    }
    updateLogs()

    // repeat action each 3s
    const intervalId = setInterval(() => updateLogs(), 3000)

    return () => {
      clearInterval(intervalId)
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
        title={t('logs:title')}
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
