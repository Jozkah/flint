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
import { useArchiveEnabled } from '@/hooks/useArchiveEnabled'

interface DeleteAssistantDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  /** Named in the archive confirmation, so it says which assistant moves. */
  assistantName?: string
}

export function DeleteAssistantDialog({
  open,
  onOpenChange,
  onConfirm,
  assistantName,
}: DeleteAssistantDialogProps) {
  const { t } = useTranslation()
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const archiveOn = useArchiveEnabled()

  const handleConfirm = () => {
    onConfirm()
  }

  const handleCancel = () => {
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[425px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          // Open on Cancel: a reflexive Enter must not delete (#78).
          cancelButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {archiveOn ? t('archive:moveTitle') : t('assistants:deleteConfirmation')}
          </DialogTitle>
          <DialogDescription>
            {archiveOn
              ? assistantName
                ? t('archive:moveBody', { title: assistantName })
                : t('archive:moveGeneric')
              : t('assistants:deleteConfirmationDesc')}
          </DialogDescription>
        </DialogHeader>
        {/* A two-line confirmation never scrolls, so its footer is plain: the
            sticky band (border and slab) belongs to long forms. */}
        <DialogFooter className="mb-0">
          <Button
            ref={cancelButtonRef}
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            className="w-full sm:w-auto pointer-coarse:h-11"
          >
            {t('assistants:cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            size="sm"
            className="w-full sm:w-auto pointer-coarse:h-11"
            aria-label={archiveOn ? t('archive:moveButton') : t('assistants:delete')}
          >
            {archiveOn ? t('archive:moveButton') : t('assistants:delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
