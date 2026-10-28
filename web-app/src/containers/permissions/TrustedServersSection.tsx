import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { MCPTrustReport } from '@/services/mcp/types'
import { StatusChip } from '@/containers/StatusChip'
import { EMPTY, REVOKE, GRANT_TONE, InlineError, errorId, type GrantState, type ServerRow } from '@/containers/permissions/shared'

export function TrustedServersSection({
  servers,
  report,
  serversError,
  serverErrors,
  busyServer,
  onRevokeServer,
}: {
  servers: ServerRow[]
  report: MCPTrustReport | null
  serversError: string | null
  serverErrors: Record<string, string>
  busyServer: string | null
  onRevokeServer: (name: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const grantLabel = (state: GrantState) => {
    switch (state) {
      case 'current':
        return t('permissions:settings.stateTrusted')
      case 'changed':
        return t('permissions:settings.stateChanged')
      case 'missing':
        return t('permissions:settings.stateMissing')
      case 'unknown':
        return t('permissions:settings.stateUnknown')
    }
  }
  return (
    <Card
      title={t('permissions:settings.trustedServers')}
      description={t('permissions:settings.trustedServersDesc')}
    >
      {serversError && (
        <InlineError>
          {t('permissions:settings.loadServersFailed', {
            error: serversError,
          })}
        </InlineError>
      )}
      {servers.length === 0 ? (
        <p className={EMPTY}>
          {t('permissions:settings.noTrustedServers')}
        </p>
      ) : (
        <ul className="flex flex-col">
          {servers.map((server) => (
            <li
              key={`server-${server.name}`}
              className="border-b border-dashed border-border px-0.5 py-[11px] last:border-b-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 [&>:first-child]:flex-[1_1_10rem]">
                <div className="min-w-0 space-y-0.5">
                  <p className="break-all text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                    {t('permissions:settings.serverLabel', {
                      server: server.name,
                    })}
                  </p>
                  {server.state === 'changed' && (
                    <p className="text-xs leading-[1.4] text-muted-foreground">
                      {t('permissions:settings.serverChanged')}
                    </p>
                  )}
                  {server.state === 'missing' && (
                    <p className="text-xs leading-[1.4] text-muted-foreground">
                      {t('permissions:settings.serverMissing')}
                    </p>
                  )}
                  {server.inApp && !server.inBackend && report && (
                    <p className="text-xs leading-[1.4] text-muted-foreground">
                      {t('permissions:settings.serverAppOnly')}
                    </p>
                  )}
                  {server.inBackend && !server.inApp && (
                    <p className="text-xs leading-[1.4] text-muted-foreground">
                      {t('permissions:settings.serverBackendOnly')}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <StatusChip
                    tone={GRANT_TONE[server.state]}
                    data-testid={`permissions-server-state-${server.name}`}
                  >
                    {grantLabel(server.state)}
                  </StatusChip>
                  <Button
                    variant="destructive"
                    className={REVOKE}
                    disabled={busyServer === server.name}
                    aria-busy={busyServer === server.name}
                    aria-describedby={
                      serverErrors[server.name]
                        ? errorId(server.name)
                        : undefined
                    }
                    aria-label={t('permissions:settings.revokeLabel', {
                      name: server.name,
                    })}
                    onClick={() => void onRevokeServer(server.name)}
                  >
                    {t('permissions:settings.revoke')}
                  </Button>
                </div>
              </div>
              {serverErrors[server.name] && (
                <InlineError id={errorId(server.name)}>
                  {serverErrors[server.name]}
                </InlineError>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
