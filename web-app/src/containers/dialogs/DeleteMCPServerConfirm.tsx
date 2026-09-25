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
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'

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
        <div className="space-y-2 rounded-lg bg-muted px-3 py-2 text-sm text-fg-2">
          <p>{t('mcp-servers:deleteServer.approvalsRemoved')}</p>
          <p>{t('mcp-servers:deleteServer.disableInstead')}</p>
        </div>
        <DialogFooter className={STICKY_DIALOG_FOOTER}>
          <Button
            size="sm"
            variant="ghost"
            className="pointer-coarse:h-11"
            onClick={() => onOpenChange(false)}
          >
            {t('common:cancel')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            className="pointer-coarse:h-11"
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
