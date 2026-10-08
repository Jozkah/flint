import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'

import { useServerLogs } from '@/hooks/useServerLogs'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { LogsDashboard } from '@/containers/LogViewer'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.localApiServerlogs as any)({
  component: LogsViewer,
})

function LogsViewer() {
  const { t } = useTranslation()
  const logs = useServerLogs()

  return (
    <LogsDashboard
      title={t('logs:serverTitle')}
      description={t('logs:serverDescription')}
      fileName="server.log"
      logs={logs}
    />
  )
}
