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
  return !uiMessageHasMeaningfulContent(message)
}
