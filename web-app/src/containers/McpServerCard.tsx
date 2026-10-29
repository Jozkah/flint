import {
  Braces,
  ChevronDown,
  ChevronUp,
  FileText,
  Pencil,
  Power,
  Trash2,
} from 'lucide-react'
import type { MCPServerConfig } from '@/hooks/useMCPServers'
import { ServerToolTimeoutInput } from '@/containers/ServerToolTimeoutInput'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { selfApprovalToolsOf } from '@/lib/selfApprovalTools'
import { maskSensitiveUrl } from '@/lib/maskSensitiveUrl'
import { McpServerAuth } from '@/containers/McpServerAuth'
import {
  McpServerDetails,
  McpServerStatus,
  mcpServerErrorId,
} from '@/containers/McpServerConnectionDetails'
import { LiveChart } from '@/containers/engine/LiveChart'
import { RowMenu } from '@/containers/engine/RowMenu'
import { bucketCounts, type ToolCallSample } from '@/stores/engine-activity-store'
import type { deriveConnectionState } from '@/lib/mcpConnectionState'
import type { deriveMcpServerProfile } from '@/lib/mcpServerProfile'
import type { MCPAuthStatus } from '@/services/mcp/types'
import { cn } from '@/lib/utils'
import { CHART_BUCKETS, mcpIdSafe, serverColor } from '@/lib/mcpServerVisual'

/** What the page derived for one server: its auth, profile and connection. */
export type McpServerSnapshot = {
  authStatus: MCPAuthStatus | undefined
  profile: ReturnType<typeof deriveMcpServerProfile>
  snapshot: ReturnType<typeof deriveConnectionState>
}

/** The page's handlers a server card or row calls, keyed by server name. */
export type McpServerHandlers = {
  onContextMenu: (key: string, x: number, y: number) => void
  onToggle: (key: string, checked: boolean) => void
  onAuthorize: (key: string) => void
  onClearAuth: (key: string) => void
  onAutoApprove: (key: string, checked: boolean) => void
  onLog: (key: string) => void
  onEdit: (key: string) => void
  onEditJson: (key: string) => void
  onDelete: (key: string) => void
  onToggleExpanded: (key: string) => void
  onDescribe: (key: string) => void
  onStartNow: (key: string) => void
  onStopNow: (key: string) => void
  onSetStartWithFlint: (
    key: string,
    config: MCPServerConfig,
    checked: boolean
  ) => void
  onSetToolTimeout: (
    key: string,
    config: MCPServerConfig,
    seconds: number | undefined
  ) => void
}

export type McpServerItemProps = {
  serverKey: string
  config: MCPServerConfig
  /** Place in the configuration, for the avatar colour. */
  position: number
  view: McpServerSnapshot
  /** Tool names: `undefined` while loading or off, `null` when unreadable. */
  toolNames: string[] | null | undefined
  loading: boolean
  approved: boolean
  handlers: McpServerHandlers
}

export function McpServerAvatar({
  serverKey,
  position,
  className,
}: {
  serverKey: string
  position: number
  className: string
}) {
  return (
    <span
      aria-hidden
      style={{ ['--c' as string]: serverColor(position) }}
      className={className}
    >
      {serverKey.trim().charAt(0).toUpperCase()}
    </span>
  )
}

type McpServerCardProps = McpServerItemProps & {
  index: number
  expanded: boolean
  approvalChanged: boolean
  toolCalls: ToolCallSample[]
  defaultToolTimeoutSeconds: number
  authorizing: boolean
  consentUrl: string | undefined
}

export function McpServerCard({
  serverKey: key,
  config,
  position,
  view,
  toolNames,
  loading,
  approved,
  handlers,
  index,
  expanded,
  approvalChanged,
  toolCalls,
  defaultToolTimeoutSeconds,
  authorizing,
  consentUrl,
}: McpServerCardProps) {
  const { t } = useTranslation()
  const { authStatus, profile, snapshot } = view
  const off = snapshot.state === 'disabled' || snapshot.state === 'not-installed'
  const series = bucketCounts(
    toolCalls.filter((c) => c.server === key),
    CHART_BUCKETS,
    60_000
  )
  const idSafe = mcpIdSafe(key)
  const autoApproveHint = t('mcp-servers:autoApproveServerHint', { defaultValue: "Auto-approves this server's tools only. The switch for every MCP tool is under Settings > Permissions." })
  return (
    <Frame
      data-testid={`mcp-server-${idSafe}`}
      className="motion-safe:animate-rise-in"
      style={{ animationDelay: `${60 + index * 50}ms` }}
      onContextMenu={(e: React.MouseEvent) => {
        e.preventDefault()
        handlers.onContextMenu(key, e.clientX, e.clientY)
      }}
    >
      <FrameHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[length:calc(var(--ui-font-base)*0.8125)] text-foreground">
              {key}
            </span>
            <Chip mono className="h-5 uppercase">
              {config.type || 'stdio'}
            </Chip>
            {config.official && (
              <Chip className="h-5">
                <img
                  src="/images/flint-logo.png"
                  alt="Flint"
                  className="size-3 object-contain"
                />
                <span>{t('uiLeftovers:official')}</span>
              </Chip>
            )}
          </span>
        }
        icon={
          <McpServerAvatar
            serverKey={key}
            position={position}
            className="grid size-[26px] place-items-center rounded-lg bg-[color-mix(in_oklab,var(--c)_16%,transparent)] text-xs font-bold text-[var(--c)] shadow-[inset_0_0_0_0.8px_color-mix(in_oklab,var(--c)_30%,transparent)]"
          />
        }
        actions={
          <Switch
            checked={snapshot.switchOn}
            loading={loading || snapshot.state === 'connecting'}
            aria-label={t('mcp-servers:connection.toggleLabel', {
              serverName: key,
            })}
            aria-describedby={
              snapshot.failure ? mcpServerErrorId(key) : undefined
            }
            onCheckedChange={(checked) => handlers.onToggle(key, checked)}
          />
        }
      />
      <FrameBody className={cn('gap-2.5 p-3', off && '[&>*:not(footer)]:opacity-70')}>
        <div className="flex items-start justify-between gap-2 text-xs">
          <McpServerStatus
            compact
            serverName={key}
            snapshot={snapshot}
            toolNames={toolNames}
            canAuthorize={!!authStatus?.canAuthenticate}
            onRetry={() => handlers.onToggle(key, true)}
            onAuthorize={() => handlers.onAuthorize(key)}
          />
          <span className="shrink-0 pt-0.5 text-muted-foreground tabular-nums">
            {toolNames
              ? t('engine:mcp.toolsCount', { count: toolNames.length })
              : '—'}
          </span>
        </div>
        <LiveChart
          series={series}
          // One accent for every server: the avatar already says which one it is.
          color="var(--series-a)"
          readout={{
            now: t('engine:chart.now'),
            ago: (count) => t('engine:chart.ago', { count }),
            windowStart: t('engine:chart.ago', { count: CHART_BUCKETS }),
            unit: t('engine:chart.calls'),
          }}
          // Recorded calls stay visible after a server stops; only a
          // server with nothing in the window reads as off.
          off={!snapshot.connected && series.every((v) => v === 0)}
          label={t('engine:mcp.callsPerMin')}
          windowLabel={t('engine:mcp.window', { count: CHART_BUCKETS })}
          peakLabel={t('engine:chart.peak')}
          avgLabel={t('engine:chart.avg')}
          format={(v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))}
        />
        <p className="m-0 line-clamp-2 min-h-[34px] font-mono text-[length:calc(var(--ui-font-base)*0.71875)] leading-normal text-muted-foreground">
          {toolNames && toolNames.length > 0
            ? t('mcp-servers:connection.toolsAvailable', {
                count: toolNames.length,
                names: toolNames.join(' · '),
              })
            : config.official
              ? t('engine:mcp.needsExtension')
              : t('mcp-servers:connection.toolsWhenConnected')}
        </p>
        {selfApprovalToolsOf(toolNames).length > 0 && (
          <p
            role="note"
            data-testid={`mcp-self-approval-${idSafe}`}
            className="m-0 rounded-md bg-warning-tint px-2 py-1 text-[length:calc(var(--ui-font-base)*0.71875)] leading-normal text-warning"
          >
            {t('mcp-servers:selfApproval.note', {
              names: selfApprovalToolsOf(toolNames).join(', '),
            })}
          </p>
        )}
        {expanded && (
          <div className="min-w-0 border-t border-dashed border-border pt-2 text-xs text-muted-foreground">
            <div className="mb-1">
              Transport:{' '}
              <span className="font-mono text-xs uppercase text-fg-2">
                {config.type || 'stdio'}
              </span>
            </div>

            {config.type === 'stdio' || !config.type ? (
              <>
                <div className="break-all">
                  {t('mcp-servers:command')}:{' '}
                  <span className="font-mono text-xs text-fg-2">
                    {config.command}
                  </span>
                </div>
                <div className="my-1 break-all">
                  {t('mcp-servers:args')}:{' '}
                  <span className="font-mono text-xs text-fg-2">
                    {config?.args?.join(', ')}
                  </span>
                </div>
                {config.env && Object.keys(config.env).length > 0 && (
                  <div className="break-all">
                    {t('mcp-servers:env')}:{' '}
                    {Object.entries(config.env)
                      .map(([key]) => `${key}=******`)
                      .join(', ')}
                  </div>
                )}
                {config.official && (
                  <div className="mt-2 pt-2 text-xs text-muted-foreground">
                    <p className="mb-1">
                      {t('mcp-servers:browserExtension.requires')}
                    </p>
                    <a
                      href="https://chromewebstore.google.com/detail/jan-browser-mcp/mkciifcjehgnpaigoiaakdgabbpfppal"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-acc-text underline-offset-4 hover:underline"
                    >
                      {t('mcp-servers:browserExtension.install')}
                    </a>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="break-all">
                  URL:{' '}
                  <span className="font-mono text-xs text-fg-2">
                    {maskSensitiveUrl(config.url || '')}
                  </span>
                </div>
                {config.headers && Object.keys(config.headers).length > 0 && (
                  <div className="my-1 break-all">
                    Headers:{' '}
                    {Object.entries(config.headers)
                      .map(([key]) => `${key}=******`)
                      .join(', ')}
                  </div>
                )}
                {config.timeout && <div>Timeout: {config.timeout}s</div>}
                <McpServerAuth
                  status={authStatus}
                  authorizing={authorizing}
                  consentUrl={consentUrl}
                  onAuthorize={() => handlers.onAuthorize(key)}
                  onClearAuth={() => handlers.onClearAuth(key)}
                />
              </>
            )}
          </div>
        )}
        {snapshot.enabled && (
          <div
            className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
            data-testid={`mcp-lifecycle-${idSafe}`}
          >
            <label className="flex items-center gap-2">
              <Switch
                checked={!!config.startWithFlint}
                aria-label={t('mcp-servers:lifecycle.startWithFlint')}
                onCheckedChange={(checked) =>
                  handlers.onSetStartWithFlint(key, config, checked)
                }
              />
              <span>{t('mcp-servers:lifecycle.startWithFlint')}</span>
            </label>
            <label className="flex items-center gap-2">
              <span>{t('mcp-servers:lifecycle.toolTimeout')}</span>
              <ServerToolTimeoutInput
                seconds={config.toolCallTimeoutSeconds}
                placeholder={String(defaultToolTimeoutSeconds)}
                ariaLabel={t('mcp-servers:lifecycle.toolTimeout')}
                onCommit={(seconds) =>
                  handlers.onSetToolTimeout(key, config, seconds)
                }
              />
            </label>
            {snapshot.connected ? (
              <button
                type="button"
                className="rounded-md border border-border px-2 py-0.5 text-fg-2 hover:bg-secondary"
                onClick={() => handlers.onStopNow(key)}
              >
                {t('mcp-servers:lifecycle.stop')}
              </button>
            ) : (
              <button
                type="button"
                disabled={snapshot.state === 'connecting'}
                className="rounded-md border border-border px-2 py-0.5 text-fg-2 hover:bg-secondary disabled:opacity-50"
                onClick={() => handlers.onStartNow(key)}
              >
                {t('mcp-servers:lifecycle.start')}
              </button>
            )}
          </div>
        )}
        <McpServerDetails
          profile={profile}
          serverName={key}
          onGenerateDescription={() => handlers.onDescribe(key)}
          toolNames={toolNames}
          authStateLabel={
            authStatus
              ? t(`mcp-servers:auth.state.${authStatus.state}`)
              : undefined
          }
        />
        {approvalChanged && (
          <p
            id={`mcp-approval-changed-${idSafe}`}
            className="m-0 text-xs text-warning"
          >
            {t('mcp-servers:approval.changedSinceApproval')}
          </p>
        )}
        <footer className="flex items-center gap-1 border-t border-dashed border-border pt-2">
          <label
            className="flex min-h-11 cursor-pointer items-center gap-2 text-xs font-medium text-secondary-foreground sm:min-h-0"
            title={autoApproveHint}
          >
            <Switch
              checked={approved}
              aria-label={t('mcp-servers:autoApproveServer')}
              aria-describedby={
                approvalChanged ? `mcp-approval-changed-${idSafe}` : undefined
              }
              onCheckedChange={(checked) =>
                handlers.onAutoApprove(key, checked)
              }
            />
            {t('engine:mcp.autoApprove')}
          </label>
          <span className="flex-1" />
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground pointer-coarse:size-11"
            onClick={() => handlers.onLog(key)}
            title={t('mcp-servers:serverLog.title', { serverName: key })}
            aria-label={t('mcp-servers:serverLog.title', { serverName: key })}
          >
            <FileText aria-hidden />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground pointer-coarse:size-11"
            onClick={() => handlers.onEdit(key)}
            title={t('mcp-servers:editServer')}
            aria-label={`${t('mcp-servers:editServer')}: ${key}`}
          >
            <Pencil aria-hidden />
          </Button>
          <RowMenu
            label={t('engine:mcp.moreActions', { serverName: key })}
            items={[
              {
                label: t(
                  expanded
                    ? 'mcp-servers:collapseServer'
                    : 'mcp-servers:expandServer'
                ),
                icon: expanded ? <ChevronUp /> : <ChevronDown />,
                onSelect: () => handlers.onToggleExpanded(key),
              },
              {
                label: t('mcp-servers:editJson.title', { serverName: key }),
                icon: <Braces />,
                onSelect: () => handlers.onEditJson(key),
              },
              {
                label: snapshot.switchOn
                  ? t('mcp-servers:connection.disable')
                  : t('mcp-servers:connection.enable'),
                icon: <Power />,
                onSelect: () => handlers.onToggle(key, !snapshot.switchOn),
              },
              'separator',
              {
                label: t('mcp-servers:deleteServer.title'),
                icon: <Trash2 />,
                destructive: true,
                onSelect: () => handlers.onDelete(key),
              },
            ]}
          />
        </footer>
      </FrameBody>
    </Frame>
  )
}
