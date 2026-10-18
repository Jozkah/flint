import { useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useThreads } from '@/hooks/useThreads'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { useArchiveEnabled } from '@/hooks/useArchiveEnabled'

interface DeleteProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId?: string
  projectName?: string
}

export function DeleteProjectDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
}: DeleteProjectDialogProps) {
  const { t } = useTranslation()
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const { deleteFolderWithThreads } = useThreadManagement()
  const archiveOn = useArchiveEnabled()

  // A number, so chats changing elsewhere never re-render the dialog.
  const threadCount = useThreads((state) => {
    if (!projectId) return 0
    let n = 0
    for (const thread of Object.values(state.threads))
      if (thread.metadata?.project?.id === projectId) n++
    return n
  })

  const handleConfirm = async () => {
    if (!projectId) return

    try {
      await deleteFolderWithThreads(projectId)
      toast.success(
        projectName
          ? t('projects.deleteProjectDialog.successWithName', { projectName })
          : t('projects.deleteProjectDialog.successWithoutName')
      )
      onOpenChange(false)
    } catch (error) {
      toast.error(t('projects.deleteProjectDialog.error'))
      console.error('Delete project error:', error)
    }
  }

  const hasThreads = threadCount > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          // Open on Cancel: a reflexive Enter must not delete (#78).
          cancelButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('projects.deleteProjectDialog.title')}</DialogTitle>
          <DialogDescription>
            {archiveOn
              ? t('archive:moveBody', { title: projectName ?? '' })
              : hasThreads
              ? t('projects.deleteProjectDialog.permanentDelete')
              : t('projects.deleteProjectDialog.deleteEmptyProject', {
                  projectName,
                })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            ref={cancelButtonRef}
            size="sm"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={handleConfirm}
            aria-label={t('projects.deleteProjectDialog.ariaLabel', {
              projectName: projectName || t('projects.title').toLowerCase(),
            })}
          >
            {archiveOn
              ? t('archive:moveButton')
              : t('projects.deleteProjectDialog.deleteButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
