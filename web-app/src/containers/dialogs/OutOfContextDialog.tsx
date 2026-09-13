import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useContextSizeApproval } from '@/hooks/useModelContextApproval'
import { useTranslation } from '@/i18n'

export default function OutOfContextPromiseModal() {
  const { t } = useTranslation()
  const { isModalOpen, modalProps, setModalOpen } = useContextSizeApproval()
  if (!modalProps) {
    return null
  }
  const { onApprove, onDeny } = modalProps

  const handleContextLength = () => {
    onApprove('ctx_len')
  }

  const handleContextShift = () => {
    onApprove('context_shift')
  }

  const handleDialogOpen = (open: boolean) => {
    setModalOpen(open)
    if (!open) {
      onDeny()
    }
  }

  return (
    <Dialog open={isModalOpen} onOpenChange={handleDialogOpen}>
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-start gap-3 text-left">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-warning-tint text-warning">
              <AlertTriangle className="size-4" />
            </span>
            <DialogTitle className="min-w-0 self-center">
              {t('model-errors:title')}
            </DialogTitle>
          </div>
        </DialogHeader>
        <DialogDescription className="text-ink-2 leading-relaxed">
          {t('model-errors:description')}
          <br />
          <br />
          {t('model-errors:increaseContextSizeDescription')}
        </DialogDescription>
        <DialogFooter>
          <Button
            variant="outline"
            className="pointer-coarse:h-11"
            onClick={() => {
              handleContextShift()
            }}
          >
            {t('model-errors:truncateInput')}
          </Button>
          <Button
            autoFocus
            className="pointer-coarse:h-11"
            onClick={() => {
              handleContextLength()
            }}
          >
            {t('model-errors:increaseContextSize')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
