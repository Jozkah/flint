import { Copy, Play, RefreshCw, Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ExportSubmenu } from '@/components/ExportMenu'
import type { BuildDoc } from '@/lib/exportAction'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * A message's right-click menu. It opens at the pointer: `point` is in the
 * message's own coordinates. An action is offered only when its handler is
 * passed.
 */
export function MessageContextMenu({
  open,
  onOpenChange,
  point,
  onCopy,
  buildExport,
  onRegenerate,
  onContinue,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  point: { x: number; y: number }
  onCopy: () => void
  buildExport: BuildDoc
  onRegenerate?: () => void
  onContinue?: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          data-testid="message-menu-anchor"
          className="pointer-events-none absolute size-0"
          style={{ left: point.x, top: point.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={onCopy}>
          <Copy className="size-4" />
          {t('chat:actions.copy')}
        </DropdownMenuItem>

        <ExportSubmenu build={buildExport} />

        {onRegenerate && (
          <DropdownMenuItem onClick={onRegenerate}>
            <RefreshCw className="size-4" />
            {t('chat:actions.regenerate')}
          </DropdownMenuItem>
        )}

        {onContinue && (
          <DropdownMenuItem onClick={onContinue}>
            <Play className="size-4" />
            {t('chat:actions.continue')}
          </DropdownMenuItem>
        )}

        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
              {t('chat:actions.delete')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
