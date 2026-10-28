import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { StatusChip } from '@/containers/StatusChip'
import { REVOKE, InlineError, errorId, type ServerRow, type RenewalRow } from '@/containers/permissions/shared'

export function StaleApprovalsSection({
  pendingRenewals,
  servers,
  serverErrors,
  busyServer,
  onRevokeServer,
}: {
  pendingRenewals: RenewalRow[]
  servers: ServerRow[]
  serverErrors: Record<string, string>
  busyServer: string | null
  onRevokeServer: (name: string) => Promise<void>
}) {
  const { t } = useTranslation()
  return (
    <Card
      anchor="settings-permissions-renewal"
      title={t('permissions:settings.needsRenewal')}
      description={t('permissions:settings.needsRenewalDesc')}
    >
      <ul className="flex flex-col">
        {pendingRenewals.map((row) => (
          <li
            key={`renewal-${row.name}`}
            className="border-b border-dashed border-border px-0.5 py-[11px] last:border-b-0"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 [&>:first-child]:flex-[1_1_10rem]">
              <div className="min-w-0 space-y-0.5">
                <p className="break-all text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                  {t('permissions:settings.needsRenewalLabel', {
                    server: row.name,
                  })}
                </p>
                <p className="text-xs leading-[1.4] text-muted-foreground">
                  {row.reason === 'changed'
                    ? t('permissions:settings.reasonChanged')
                    : t('permissions:settings.reasonLegacy')}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <StatusChip tone="warning">
                  {t('permissions:settings.stateNeedsRenewal')}
                </StatusChip>
                <Button
                  variant="outline"
                  className={REVOKE}
                  disabled={busyServer === row.name}
                  aria-busy={busyServer === row.name}
                  aria-describedby={
                    serverErrors[row.name] ? errorId(row.name) : undefined
                  }
                  aria-label={t('permissions:settings.dismissLabel', {
                    name: row.name,
                  })}
                  onClick={() => void onRevokeServer(row.name)}
                >
                  {t('permissions:settings.dismiss')}
                </Button>
              </div>
            </div>
            {serverErrors[row.name] &&
              !servers.some((server) => server.name === row.name) && (
                <InlineError id={errorId(row.name)}>
                  {serverErrors[row.name]}
                </InlineError>
              )}
          </li>
        ))}
      </ul>
    </Card>
  )
}
