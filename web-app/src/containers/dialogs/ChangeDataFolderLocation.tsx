import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Folder } from 'lucide-react'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { useTranslation } from '@/i18n/react-i18next-compat'

interface ChangeDataFolderLocationProps {
  children: React.ReactNode
  currentPath: string
  newPath: string
  onConfirm: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function ChangeDataFolderLocation({
  children,
  currentPath,
  newPath,
  onConfirm,
  open,
  onOpenChange,
}: ChangeDataFolderLocationProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Folder className="size-5 text-muted-foreground" aria-hidden />
            {t('settings:dialogs.changeDataFolder.title')}
          </DialogTitle>
          <DialogDescription>
            {t('settings:dialogs.changeDataFolder.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <h4 className="text-sm font-medium mb-2">
              {t('settings:dialogs.changeDataFolder.currentLocation')}
            </h4>
            <div className="rounded-md border border-border bg-muted p-2">
              <code className="font-mono text-xs text-fg-2 break-all">
                {currentPath}
              </code>
            </div>
          </div>

          <div>
            <h4 className="text-sm font-medium mb-2">
              {t('settings:dialogs.changeDataFolder.newLocation')}
            </h4>
            <div className="rounded-md border border-border-strong bg-card p-2">
              <code className="font-mono text-xs text-foreground break-all">{newPath}</code>
            </div>
          </div>
        </div>

        <DialogFooter className={STICKY_DIALOG_FOOTER}>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" className="pointer-coarse:h-11">
              {t('settings:dialogs.changeDataFolder.cancel')}
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button size="sm" className="pointer-coarse:h-11" onClick={onConfirm}>
              {t('settings:dialogs.changeDataFolder.changeLocation')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
