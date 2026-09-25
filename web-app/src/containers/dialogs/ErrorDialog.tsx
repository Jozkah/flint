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
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
} from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { toast } from 'sonner'
import { useState } from 'react'
import { useAppState } from '@/hooks/useAppState'

export default function ErrorDialog() {
  const { t } = useTranslation()
  const errorMessage = useAppState((state) => state.errorMessage)
  const setErrorMessage = useAppState((state) => state.setErrorMessage)
  const [isCopying, setIsCopying] = useState(false)
  const [isDetailExpanded, setIsDetailExpanded] = useState(true)

  const handleCopy = async () => {
    setIsCopying(true)
    try {
      await navigator.clipboard.writeText(errorMessage?.message ?? '')
      toast.success(t('common:toast.errorCopied.title'), {
        id: 'copy-error',
        description: t('common:toast.errorCopied.description'),
      })
    } catch {
      toast.error(t('common:toast.errorCopyFailed.title'), {
        id: 'copy-error-failed',
        description: t('common:toast.errorCopyFailed.description'),
      })
    } finally {
      setTimeout(() => setIsCopying(false), 2000)
    }
  }

  const handleDialogOpen = (open: boolean) => {
    setErrorMessage(open ? errorMessage : undefined)
  }

  return (
    <Dialog open={!!errorMessage} onOpenChange={handleDialogOpen}>
      <DialogContent showCloseButton={false}>
        {/* What happened */}
        <DialogHeader>
          <div className="flex items-start gap-3 text-left">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-destructive-tint text-destructive">
              <AlertTriangle className="size-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle>{t('common:error')}</DialogTitle>
              <DialogDescription className="mt-1 text-fg-2">
                {errorMessage?.title ?? t('common:errorDialog.titleFallback')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-w-0 space-y-2 rounded-md border border-border bg-muted p-3">
          <button
            type="button"
            aria-expanded={isDetailExpanded}
            onClick={() => setIsDetailExpanded((prev) => !prev)}
            className="flex cursor-pointer items-center gap-1 rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground pointer-coarse:min-h-11"
          >
            {isDetailExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            {t('common:errorDialog.details')}
          </button>

          {isDetailExpanded && (
            <div
              className="max-h-[150px] overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border bg-card p-2.5 font-mono text-xs leading-relaxed text-fg-2"
              ref={(el) => {
                if (el) {
                  el.scrollTop = el.scrollHeight
                }
              }}
            >
              {errorMessage?.message}
            </div>
          )}
          {/* What to do */}
          {errorMessage?.subtitle && (
            <p className="text-sm text-fg-2">{errorMessage.subtitle}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleDialogOpen(false)}
            className="pointer-coarse:h-11"
          >
            {t('common:cancel')}
          </Button>
          <Button
            onClick={() => void handleCopy()}
            disabled={isCopying}
            autoFocus
            className="pointer-coarse:h-11"
          >
            {isCopying ? (
              <>
                <Check />
                {t('common:copied')}
              </>
            ) : (
              <>
                <Copy />
                {t('common:copy')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
