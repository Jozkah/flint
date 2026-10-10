import { useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { undoableDeleteMany } from '@/lib/undoableAction'
import { route } from '@/constants/routes'
import { useArchiveEnabled } from '@/hooks/useArchiveEnabled'
import { isOpenInView } from '@/containers/dialogs/DeleteThreadDialog'

interface DeleteSelectedThreadsDialogProps {
  ids: string[]
  onDelete: (threadId: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once the delete is queued (the selection can be cleared). */
  onDone?: () => void
}

/** Confirms deleting several chats at once; one Undo toast covers them all. */
export function DeleteSelectedThreadsDialog({
  ids,
  onDelete,
  open,
  onOpenChange,
  onDone,
}: DeleteSelectedThreadsDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const archiveOn = useArchiveEnabled()
  const cancelRef = useRef<HTMLButtonElement>(null)

  const handleDelete = () => {
    onOpenChange(false)
    const leaving = ids.some((id) => isOpenInView(id))
    undoableDeleteMany({
      ids,
      message: archiveOn
        ? t('archive:moved')
        : t('chat:bulkDelete.done', { count: ids.length }),
      description: t('common:toast.deleteThread.undoHint'),
      undoLabel: t('common:undo'),
      run: (all) => all.forEach((id) => onDelete(id)),
    })
    if (leaving) setTimeout(() => navigate({ to: route.home }), 0)
    onDone?.()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          // Open on Cancel: a reflexive Enter must not delete.
          cancelRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('chat:bulkDelete.title', { count: ids.length })}</DialogTitle>
          <DialogDescription>
            {archiveOn
              ? t('chat:bulkDelete.descriptionArchive', { count: ids.length })
              : t('chat:bulkDelete.description', { count: ids.length })}
          </DialogDescription>
          <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <DialogClose asChild>
              <Button ref={cancelRef} variant="ghost" size="sm" className="w-full sm:w-auto">
                {t('common:cancel')}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              className="w-full sm:w-auto"
              onClick={handleDelete}
              data-testid="confirm-delete-selected"
            >
              {archiveOn ? t('archive:moveButton') : t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  )
}
