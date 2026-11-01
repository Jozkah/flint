import { toast } from 'sonner'
import {
  continueFromSummary,
  ContinueFromSummaryError,
} from '@/lib/continueFromSummary'

type Translate = (key: string) => string

/**
 * Continue a chat from a summary with a progress toast. Calls `onDone` with
 * the new chat's id; every failure says what to do about it.
 */
export function continueFromSummaryWithToast(
  threadId: string,
  t: Translate,
  onDone: (newThreadId: string) => void
): void {
  const controller = new AbortController()
  const pending = toast.loading(t('chat:continueSummary.working'), {
    // A long local summary must be cancellable.
    cancel: {
      label: t('chat:continueSummary.cancel'),
      onClick: () => controller.abort(),
    },
  })
  void continueFromSummary(threadId, { signal: controller.signal })
    .then(
      (id) => {
        toast.dismiss(pending)
        toast.success(t('chat:continueSummary.done'))
        // The summary worked: a throw while opening the new chat is not a
        // failed summary (LIBA-010).
        try {
          onDone(id)
        } catch (error) {
          console.error('Opening the continued chat failed:', error)
        }
      },
      (error) => {
        toast.dismiss(pending)
        if (controller.signal.aborted) return
        const code =
          error instanceof ContinueFromSummaryError ? error.code : 'summary-failed'
        toast.error(t(`chat:continueSummary.errors.${code}`))
      }
    )
}
