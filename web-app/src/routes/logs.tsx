import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'

import { useEffect, useState, useRef } from 'react'
import { ScrollText } from 'lucide-react'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { SystemPageHeader } from '@/containers/SystemPageHeader'
import { CopyLogsButton, LogViewer } from '@/containers/LogViewer'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.appLogs as any)({
  component: LogsViewer,
})

function LogsViewer() {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogEntry[]>([])
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

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
      <SystemPageHeader
        title={t('logs:title')}
        icon={<ScrollText className="size-4" />}
        actions={<CopyLogsButton logs={logs} />}
      />
      <div className="flex min-h-0 flex-1 flex-col p-3 md:p-4">
        <LogViewer
          ref={logsContainerRef}
          logs={logs}
          emptyText={t('logs:noLogs')}
        />
      </div>
    </div>
  )
}
