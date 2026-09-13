import { useRef } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'

interface DeleteAssistantDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function DeleteAssistantDialog({
  open,
  onOpenChange,
  onConfirm,
}: DeleteAssistantDialogProps) {
  const { t } = useTranslation()
  const deleteButtonRef = useRef<HTMLButtonElement>(null)

  const handleConfirm = () => {
    onConfirm()
  }

  const handleCancel = () => {
    onOpenChange(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleConfirm()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[425px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          deleteButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('assistants:deleteConfirmation')}</DialogTitle>
          <DialogDescription>
            {t('assistants:deleteConfirmationDesc')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className={STICKY_DIALOG_FOOTER}>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            className="w-full sm:w-auto pointer-coarse:h-11"
          >
            {t('assistants:cancel')}
          </Button>
          <Button
            ref={deleteButtonRef}
            variant="destructive"
            onClick={handleConfirm}
            size="sm"
            onKeyDown={handleKeyDown}
            className="w-full sm:w-auto pointer-coarse:h-11"
            aria-label={t('assistants:delete')}
          >
            {t('assistants:delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
