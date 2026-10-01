import { useRef, useMemo, useState } from 'react'
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
import { PermanentDeleteOption } from '@/containers/archive/PermanentDeleteOption'

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
  const threads = useThreads((state) => state.threads)
  const { deleteFolderWithThreads } = useThreadManagement()
  const archiveOn = useArchiveEnabled()
  const [permanent, setPermanent] = useState(false)

  const threadCount = useMemo(() => {
    if (!projectId) return 0

    return Object.values(threads).filter(
      (thread) => thread.metadata?.project?.id === projectId
    ).length
  }, [projectId, threads])

  const handleConfirm = async () => {
    if (!projectId) return

    try {
      if (archiveOn && permanent) await deleteFolderWithThreads(projectId, true)
      else await deleteFolderWithThreads(projectId)
      setPermanent(false)
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
          <PermanentDeleteOption checked={permanent} onChange={setPermanent} />
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
            {archiveOn && !permanent
              ? t('archive:moveButton')
              : t('projects.deleteProjectDialog.deleteButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
