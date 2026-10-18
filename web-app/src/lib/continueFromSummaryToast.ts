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
    .then((id) => {
      toast.dismiss(pending)
      toast.success(t('chat:continueSummary.done'))
      onDone(id)
    })
    .catch((error) => {
      toast.dismiss(pending)
      if (controller.signal.aborted) return
      const code =
        error instanceof ContinueFromSummaryError ? error.code : 'summary-failed'
      toast.error(t(`chat:continueSummary.errors.${code}`))
    })
}
