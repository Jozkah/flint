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
        {/* Deleting revokes every approval for the name (renderer and backend
            trust) and clears its OAuth tokens, so a server added later under
            the same name inherits nothing. Audit history is kept. */}
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>{t('mcp-servers:deleteServer.approvalsRemoved')}</p>
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
