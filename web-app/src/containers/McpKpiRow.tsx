import { Icon } from '@/components/ui/icon'
import { KpiRow, KpiTile } from '@/containers/engine/EngineKit'
import { useTranslation } from '@/i18n/react-i18next-compat'

type Props = {
  serverCount: number
  connectedCount: number
  connectingCount: number
  toolCount: number
  callsToday: number
  failedToday: number
  approvedCount: number
  allowAllMCPPermissions: boolean
}

export function McpKpiRow({
  serverCount,
  connectedCount,
  connectingCount,
  toolCount,
  callsToday,
  failedToday,
  approvedCount,
  allowAllMCPPermissions,
}: Props) {
  const { t } = useTranslation()
  return (
    <KpiRow>
      <KpiTile
        title={t('engine:mcp.kpiServers')}
        icon={<Icon name="flow" />}
        value={serverCount}
        sub={t('engine:mcp.kpiServersSub', {
          connected: connectedCount,
          connecting: connectingCount,
        })}
        delay={40}
      />
      <KpiTile
        title={t('engine:mcp.kpiTools')}
        icon={<Icon name="x-sparkle" />}
        value={toolCount}
        sub={t('engine:mcp.kpiToolsSub', { count: connectedCount })}
        delay={90}
      />
      <KpiTile
        title={t('engine:mcp.kpiCalls')}
        icon={<Icon name="x-activity" />}
        value={callsToday}
        sub={
          callsToday > 0
            ? t('engine:mcp.kpiCallsSub', {
                pct: ((failedToday / callsToday) * 100).toFixed(1),
              })
            : t('engine:mcp.kpiCallsNone')
        }
        delay={140}
      />
      <KpiTile
        title={t('engine:mcp.kpiApproved')}
        icon={<Icon name="x-shield" />}
        value={approvedCount}
        sub={
          allowAllMCPPermissions
            ? t('engine:mcp.kpiApprovedAll')
            : t('engine:mcp.kpiApprovedSub', {
                count: serverCount - approvedCount,
              })
        }
        delay={190}
      />
    </KpiRow>
  )
}
