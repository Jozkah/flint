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

interface DeleteThreadDialogProps {
  thread: Thread
  onDelete: (threadId: string) => void
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
  const deleteButtonRef = useRef<HTMLButtonElement>(null)

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
      message: t('common:toast.deleteThread.title'),
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleDelete()
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
          deleteButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('common:deleteThread')}</DialogTitle>
          <DialogDescription>
            {t('common:dialogs.deleteThread.description')}
          </DialogDescription>
          <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm" className="w-full sm:w-auto">
                {t('common:cancel')}
              </Button>
            </DialogClose>
            <Button
              ref={deleteButtonRef}
              variant="destructive"
              onClick={handleDelete}
              onKeyDown={handleKeyDown}
              size="sm"
              className="w-full sm:w-auto"
              aria-label={`${t('common:delete')} ${thread.title || t('common:newThread')}`}
            >
              {t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  )
}
