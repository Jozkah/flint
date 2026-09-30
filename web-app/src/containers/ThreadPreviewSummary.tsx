import { getServiceHub } from '@/hooks/useServiceHub'
import { useMessages } from '@/hooks/useMessages'
import { usePreviewSummary } from '@/hooks/usePreviewSummary'
import { titleTranscript } from '@/lib/regenerateTitle'

/**
 * The summary line of a chat's preview card: two written sentences on what the
 * chat is about and where it stands, asked for when the card opens. Until they
 * arrive, or when the model cannot be asked, the last thing the user said.
 */
export function ThreadPreviewSummary({
  open,
  threadId,
  updated,
  fallback,
}: {
  open: boolean
  threadId: string
  updated?: number | string
  fallback?: string
}) {
  const { summary, loading } = usePreviewSummary(
    `${threadId}\u0000${updated ?? ''}`,
    open,
    async () => {
      let messages = useMessages.getState().getMessages(threadId)
      if (messages.length === 0) {
        try {
          messages = await getServiceHub().messages().fetchMessages(threadId)
        } catch {
          return ''
        }
      }
      return titleTranscript(messages)
    }
  )
  const shown = summary ?? fallback
  if (!shown) return null
  return (
    <p
      data-testid="row-preview-summary"
      className={`mt-2 rounded-lg bg-muted px-2.5 py-2 text-xs leading-relaxed text-secondary-foreground${
        summary ? '' : ' line-clamp-4'
      }${loading && !summary ? ' opacity-60' : ''}`}
    >
      {shown}
    </p>
  )
}
