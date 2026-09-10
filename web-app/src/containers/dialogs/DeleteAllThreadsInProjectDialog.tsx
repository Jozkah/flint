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
import { IconTrash } from '@tabler/icons-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'

interface DeleteAllThreadsInProjectDialogProps {
  projectName: string
  threadCount: number
  onDeleteAll: () => void
  onDropdownClose?: () => void
}

export function DeleteAllThreadsInProjectDialog({
  projectName,
  threadCount,
  onDeleteAll,
  onDropdownClose,
}: DeleteAllThreadsInProjectDialogProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  // Focus lands on Cancel. It used to land on the destructive button, so
  // opening this dialog and pressing Enter deleted every thread at once.
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open)
    if (!open && onDropdownClose) {
      onDropdownClose()
    }
  }

  const handleDeleteAll = () => {
    onDeleteAll()
    setIsOpen(false)
    if (onDropdownClose) onDropdownClose()
    toast.success(t('common:toast.deleteAllThreads.title'), {
      id: 'delete-all-threads-in-project',
      description: t('common:toast.deleteAllThreads.description'),
    })
  }


  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <DropdownMenuItem variant="destructive" onSelect={(e) => e.preventDefault()}>
          <IconTrash size={16} />
          <span>{t('common:deleteAll')}</span>
        </DropdownMenuItem>
      </DialogTrigger>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          cancelButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t('common:dialogs.deleteAllThreadsInProject.title')}
          </DialogTitle>
          <DialogDescription>
            {t('common:dialogs.deleteAllThreadsInProject.description', { projectName, count: threadCount })}
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
              onClick={handleDeleteAll}
              size="sm"
              className="w-full sm:w-auto"
              aria-label={t('common:deleteAll')}
            >
              {t('common:deleteAll')}
            </Button>
          </DialogFooter>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  )
}