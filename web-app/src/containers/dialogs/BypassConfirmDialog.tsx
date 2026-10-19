import { useRef } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { answerBypassConfirm, useBypassConfirm } from '@/lib/bypassConfirm'

/**
 * The once-per-app-run question before Bypass is switched on. Closing it any
 * way but the confirm button (Escape, the overlay, Cancel) answers no, and
 * focus starts on Cancel so a reflexive Enter never turns Bypass on.
 */
export function BypassConfirmDialog() {
  const { t } = useTranslation()
  const request = useBypassConfirm((s) => s.request)
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next) answerBypassConfirm(false)
      }}
    >
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          cancelRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('permissions:settings.modeBypass')}</DialogTitle>
          <DialogDescription>{request?.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            ref={cancelRef}
            variant="ghost"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => answerBypassConfirm(false)}
          >
            {t('common:cancel')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => answerBypassConfirm(true)}
          >
            {t('common:confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default BypassConfirmDialog
