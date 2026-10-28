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
import {
  answerGpuCrashCpuFallback,
  useGpuCrashCpuFallback,
} from '@/lib/gpuCrashCpuFallback'

/**
 * Asks whether to load a model on the CPU after the GPU driver crashed while
 * loading it. Closing it any way but the confirm button answers no.
 */
export function GpuCrashCpuFallbackDialog() {
  const { t } = useTranslation()
  const request = useGpuCrashCpuFallback((s) => s.request)

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next) answerGpuCrashCpuFallback(false)
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('model-errors:gpuCrashCpuFallbackTitle')}</DialogTitle>
          <DialogDescription>
            {t('model-errors:gpuCrashCpuFallbackQuestion')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => answerGpuCrashCpuFallback(false)}
          >
            {t('common:cancel')}
          </Button>
          <Button
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => answerGpuCrashCpuFallback(true)}
          >
            {t('model-errors:gpuCrashCpuFallbackConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default GpuCrashCpuFallbackDialog
