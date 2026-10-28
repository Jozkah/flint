import { FileText, Pencil, Power, Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslation } from '@/i18n/react-i18next-compat'

export type McpServerCtxMenu = { key: string; x: number; y: number }

type Props = {
  ctxMenu: McpServerCtxMenu
  /** Whether the server is switched on, or null when its config is gone. */
  switchOn: boolean | null
  onClose: () => void
  onLog: (key: string) => void
  onEdit: (key: string) => void
  onToggle: (key: string, on: boolean) => void
  onDelete: (key: string) => void
}

/** The right-click menu on a server row. */
export function McpServerContextMenu({
  ctxMenu,
  switchOn,
  onClose,
  onLog,
  onEdit,
  onToggle,
  onDelete,
}: Props) {
  const { t } = useTranslation()
  return (
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          className="pointer-events-none fixed"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        className="min-w-[180px]"
      >
        <DropdownMenuItem
          onSelect={() => {
            onLog(ctxMenu.key)
            onClose()
          }}
        >
          <FileText />
          {t('mcp-servers:serverLog.title', { serverName: ctxMenu.key })}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            onEdit(ctxMenu.key)
            onClose()
          }}
        >
          <Pencil />
          {t('mcp-servers:editServer')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            if (switchOn !== null) onToggle(ctxMenu.key, !switchOn)
            onClose()
          }}
        >
          <Power />
          {switchOn
            ? t('mcp-servers:connection.disable')
            : t('mcp-servers:connection.enable')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            onDelete(ctxMenu.key)
            onClose()
          }}
        >
          <Trash2 />
          {t('mcp-servers:deleteServer.title')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
