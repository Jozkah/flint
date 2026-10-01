import { useState, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
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
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { undoableDelete } from '@/lib/undoableAction'
import { route } from '@/constants/routes'
import { useArchiveEnabled } from '@/hooks/useArchiveEnabled'

interface DeleteThreadDialogProps {
  thread: Thread
  onDelete: (threadId: string, permanent?: boolean) => void
  onDropdownClose?: () => void
  variant?: 'default' | 'project'
  open?: boolean
  onOpenChange?: (open: boolean) => void
  withoutTrigger?: boolean
}

export function DeleteThreadDialog({
  thread,
  onDelete,
  onDropdownClose,
  variant = 'default',
  open,
  onOpenChange,
  withoutTrigger,
}: DeleteThreadDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [internalOpen, setInternalOpen] = useState(false)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const archiveOn = useArchiveEnabled()

  const isControlled = open !== undefined
  const isOpen = isControlled ? !!open : internalOpen
  const setOpenSafe = (next: boolean) => {
    if (isControlled) {
      onOpenChange?.(next)
    } else {
      setInternalOpen(next)
    }
  }

  const handleOpenChange = (open: boolean) => {
    setOpenSafe(open)
    if (!open) {
      onDropdownClose?.()
    }
  }

  const handleDelete = () => {
    setOpenSafe(false)
    onDropdownClose?.()
    // Hidden at once, deleted after the undo window unless Undo is pressed.
    undoableDelete({
      id: thread.id,
      message:
        archiveOn
          ? t('archive:moved')
          : t('common:toast.deleteThread.title'),
      description: t('common:toast.deleteThread.undoHint'),
      undoLabel: t('common:undo'),
      run: () => onDelete(thread.id),
    })
    if (variant !== 'project') {
      setTimeout(() => {
        navigate({ to: route.home })
      }, 0)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {!withoutTrigger && (
        <DialogTrigger asChild>
          <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
            <Trash2 />
            <span>{t('common:delete')}</span>
          </DropdownMenuItem>
        </DialogTrigger>
      )}
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          // Open on Cancel: a reflexive Enter must not delete (#78).
          cancelButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {archiveOn ? t('archive:moveTitle') : t('common:deleteThread')}
          </DialogTitle>
          <DialogDescription>
            {archiveOn
              ? t('archive:moveBody', { title: thread.title || t('common:newThread') })
              : t('common:dialogs.deleteThread.description')}
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
              aria-label={`${t('common:delete')} ${thread.title || t('common:newThread')}`}
            >
              {archiveOn
                ? t('archive:moveButton')
                : t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  )
}
