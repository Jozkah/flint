import { useState, useRef } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Trash2 } from 'lucide-react'

interface DeleteMessageDialogProps {
  onDelete: () => void
}

export function DeleteMessageDialog({ onDelete }: DeleteMessageDialogProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  const handleDelete = () => {
    onDelete()
    setIsOpen(false)
  }

  const trigger = (
    <Button
      variant="ghost"
      size="icon-xs"
      role="button"
      tabIndex={0}
      aria-label={t('common:deleteMessage')}
      className="size-7 text-fg-2 hover:text-foreground pointer-coarse:size-11"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setIsOpen(true)
        }
      }}
    >
      <Trash2 className="size-4" />
    </Button>
  )

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          // Open on Cancel: a reflexive Enter must not delete (#78).
          cancelButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('common:deleteMessage')}</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this message? This action cannot be
            undone.
          </DialogDescription>
          <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <DialogClose asChild>
              <Button
                ref={cancelButtonRef}
                variant="ghost"
                size="sm"
                className="w-full sm:w-auto"
              >
                {t('common:cancel')}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={handleDelete}
              size="sm"
              className="w-full sm:w-auto"
              data-testid="delete-message-confirm"
            >
              {t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  )
}
