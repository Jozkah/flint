import { Braces, FileText, Pencil, Trash2 } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { McpServerStatus } from '@/containers/McpServerConnectionDetails'
import { RowMenu } from '@/containers/engine/RowMenu'
import {
  McpServerAvatar,
  type McpServerItemProps,
} from '@/containers/McpServerCard'
import { mcpIdSafe } from '@/lib/mcpServerVisual'

/** One dense line per server, for when there are too many for cards. */
export function McpServerRow({
  serverKey: key,
  config,
  position,
  view,
  toolNames,
  loading,
  approved,
  handlers,
}: McpServerItemProps) {
  const { t } = useTranslation()
  const { authStatus, snapshot } = view
  const idSafe = mcpIdSafe(key)
  const autoApproveHint = t('mcp-servers:autoApproveServerHint', { defaultValue: "Auto-approves this server's tools only. The switch for every MCP tool is under Settings > Permissions." })
  return (
    <div
      data-testid={`mcp-server-${idSafe}`}
      className="flex min-w-0 items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
      onContextMenu={(e: React.MouseEvent) => {
        e.preventDefault()
        handlers.onContextMenu(key, e.clientX, e.clientY)
      }}
    >
      <McpServerAvatar
        serverKey={key}
        position={position}
        className="grid size-[22px] shrink-0 place-items-center rounded-md bg-[color-mix(in_oklab,var(--c)_16%,transparent)] text-[length:calc(var(--ui-font-base)*0.6875)] font-bold text-[var(--c)]"
      />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate text-[length:calc(var(--ui-font-base)*0.8125)] text-foreground">
          {key}
        </span>
        <Chip mono className="h-5 shrink-0 uppercase">
          {config.type || 'stdio'}
        </Chip>
        {config.official && <Chip className="h-5 shrink-0">{t('uiLeftovers:official')}</Chip>}
      </span>
      <span className="hidden min-w-0 shrink-0 text-xs @min-[40rem]:block">
        <McpServerStatus
          compact
          serverName={key}
          snapshot={snapshot}
          toolNames={toolNames}
          canAuthorize={!!authStatus?.canAuthenticate}
          onRetry={() => handlers.onToggle(key, true)}
          onAuthorize={() => handlers.onAuthorize(key)}
        />
      </span>
      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {toolNames
          ? t('engine:mcp.toolsCount', { count: toolNames.length })
          : '—'}
      </span>
      <label
        className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-secondary-foreground"
        title={autoApproveHint}
      >
        <Switch
          checked={approved}
          aria-label={t('mcp-servers:autoApproveServer')}
          onCheckedChange={(checked) => handlers.onAutoApprove(key, checked)}
        />
        <span className="hidden @min-[48rem]:inline">
          {t('engine:mcp.autoApprove')}
        </span>
      </label>
      <Switch
        checked={snapshot.switchOn}
        loading={loading || snapshot.state === 'connecting'}
        aria-label={t('mcp-servers:connection.toggleLabel', {
          serverName: key,
        })}
        onCheckedChange={(checked) => handlers.onToggle(key, checked)}
      />
      <Button
        size="icon-sm"
        variant="ghost"
        className="text-muted-foreground"
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
            label: t('mcp-servers:serverLog.title', { serverName: key }),
            icon: <FileText />,
            onSelect: () => handlers.onLog(key),
          },
          {
            label: t('mcp-servers:editJson.title', { serverName: key }),
            icon: <Braces />,
            onSelect: () => handlers.onEditJson(key),
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
    </div>
  )
}
