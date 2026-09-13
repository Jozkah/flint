import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'

interface DeleteMCPServerConfirmProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverName: string
  onConfirm: () => void
}

export default function DeleteMCPServerConfirm({
  open,
  onOpenChange,
  serverName,
  onConfirm,
}: DeleteMCPServerConfirmProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('mcp-servers:deleteServer.title')}</DialogTitle>
          <DialogDescription>
            {t('mcp-servers:deleteServer.description', { serverName })}
          </DialogDescription>
        </DialogHeader>
        {/* Deleting does not revoke trust: the frontend auto-approve list and
            the backend `mcp_trust` store are both keyed by server name and
            neither is touched by removing the config. Say so rather than let
            a re-added server inherit approval unannounced. */}
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>{t('mcp-servers:deleteServer.approvalsKept')}</p>
          <p>{t('mcp-servers:deleteServer.disableInstead')}</p>
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common:cancel')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            autoFocus
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
          >
            {t('mcp-servers:deleteServer.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
