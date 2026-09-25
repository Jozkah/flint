import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAttachmentIngestionPrompt } from '@/hooks/useAttachmentIngestionPrompt'
import { useTranslation } from '@/i18n'
import { formatBytes } from '@/lib/utils'

export default function AttachmentIngestionDialog() {
  const { t } = useTranslation()
  const { isModalOpen, currentAttachment, currentIndex, totalCount, choose, cancel } = useAttachmentIngestionPrompt()

  if (!isModalOpen || !currentAttachment) return null

  return (
    <Dialog open={isModalOpen} onOpenChange={(open) => !open && cancel()}>
      <DialogContent onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>
            {t('common:attachmentsIngestion.title')}
            {totalCount > 1 && (
              <span className="ml-2 text-sm font-normal tabular-nums text-muted-foreground">
                ({currentIndex + 1} of {totalCount})
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="text-fg-2">
            {t('common:attachmentsIngestion.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 rounded-md border border-border bg-muted p-3">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium" title={currentAttachment.name}>
                {currentAttachment.name}
              </span>
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {currentAttachment.size && currentAttachment.size > 0
                ? formatBytes(currentAttachment.size, {
                    decimals: (value, unit) =>
                      unit === 'B' || value >= 10 ? 0 : 1,
                  })
                : ''}
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            className="pointer-coarse:h-11"
            onClick={cancel}
          >
            {t('common:cancel')}
          </Button>
          <Button
            variant="outline"
            className="pointer-coarse:h-11"
            onClick={() => choose('embeddings')}
          >
            {t('common:attachmentsIngestion.embeddings')}
          </Button>
          <Button
            className="pointer-coarse:h-11"
            onClick={() => choose('inline')}
          >
            {t('common:attachmentsIngestion.inline')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
