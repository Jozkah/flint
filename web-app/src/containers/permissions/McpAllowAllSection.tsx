import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useToolApproval } from '@/hooks/useToolApproval'
import { StatusChip } from '@/containers/StatusChip'

export function McpAllowAllSection() {
  const { t } = useTranslation()
  const allowAll = useToolApproval((s) => s.allowAllMCPPermissions)
  const setAllowAll = useToolApproval((s) => s.setAllowAllMCPPermissions)
  return (
    <Card title={t('permissions:settings.allowAllGroup')}>
      <CardItem
        wrapDescription
        anchor="settings-permissions-allow-permissions"
        title={
          <span className="flex flex-wrap items-center gap-2">
            {t('mcp-servers:allowPermissions')}
            {allowAll && (
              <StatusChip tone="warning">
                {t('permissions:settings.allowAllOn')}
              </StatusChip>
            )}
          </span>
        }
        description={t('mcp-servers:allowPermissionsDesc')}
        actions={
          <div className="shrink-0">
            <Switch
              data-testid="permissions-allow-all"
              aria-label={t('mcp-servers:allowPermissions')}
              checked={allowAll}
              onCheckedChange={setAllowAll}
            />
          </div>
        }
      />
    </Card>
  )
}
