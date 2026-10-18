import type { UIMessage } from 'ai'
import { uiMessageHasMeaningfulContent } from '@/lib/messages'

/**
 * A completed assistant turn that produced nothing to show. Aborted and
 * errored turns are excluded (the user stopped it, or the error banner already
 * explains it), as are tool-call turns whose content arrives in a later step.
 */
export function isEmptyReply({
  message,
  isAbort,
  isError,
  finishReason,
}: {
  message: UIMessage
  isAbort: boolean
  isError: boolean
  finishReason: string | undefined
}): boolean {
  if (isAbort || isError || message.role !== 'assistant') return false
  if (finishReason === 'tool-calls') return false
  // A refusal is its own explanation; see `isRefusal`.
  if (isRefusal(finishReason)) return false
  return !uiMessageHasMeaningfulContent(message)
}

/**
 * The provider stopped the reply because it declined to answer (finish reason
 * `content_filter`, which the SDK reports as `content-filter`). It is not a
 * failure of the key, the model or the connection, and the transcript should
 * not read as one.
 */
export function isRefusal(finishReason: string | undefined): boolean {
  return finishReason === 'content-filter' || finishReason === 'content_filter'
}
