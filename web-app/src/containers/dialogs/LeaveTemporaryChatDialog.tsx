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

interface LeaveTemporaryChatDialogProps {
  open: boolean
  /** A keep or discard is running; every choice is disabled until it settles. */
  busy?: boolean
  onKeep: () => void
  onDiscard: () => void
  onCancel: () => void
}

/**
 * The one question asked when leaving a temporary chat with something in it:
 * keep it, throw it away, or stay. Presentational only — the guard owns what
 * each choice does — so the three outcomes are easy to see and to test.
 *
 * Dismissing the dialog any other way (Escape, the overlay) is Cancel: the
 * safe default is always to keep the chat exactly where it is.
 */
export function LeaveTemporaryChatDialog({
  open,
  busy = false,
  onKeep,
  onDiscard,
  onCancel,
}: LeaveTemporaryChatDialogProps) {
  const { t } = useTranslation()
  const keepButtonRef = useRef<HTMLButtonElement>(null)
  const descriptionId = 'leave-temporary-chat-description'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={descriptionId}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          keepButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('chat:temporaryChatLeave.title')}</DialogTitle>
          <DialogDescription id={descriptionId}>
            {t('chat:temporaryChatLeave.description')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            {t('common:cancel')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onDiscard}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            {t('chat:temporaryChatLeave.discard')}
          </Button>
          <Button
            ref={keepButtonRef}
            variant="default"
            size="sm"
            onClick={onKeep}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            {t('chat:temporaryChatLeave.keep')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
