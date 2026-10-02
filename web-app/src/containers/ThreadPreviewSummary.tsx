import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getServiceHub } from '@/hooks/useServiceHub'
import { getActiveMessages } from '@/hooks/useActiveMessages'
import { useThreads } from '@/hooks/useThreads'
import { activePathOf } from '@/lib/message-branching'
import { usePreviewSummary } from '@/hooks/usePreviewSummary'
import { titleTranscript } from '@/lib/regenerateTitle'

type Messages = ReturnType<typeof getActiveMessages>

const firstUserText = (messages: Messages): string | undefined => {
  for (const m of messages) {
    if (m.role !== 'user') continue
    const text = m.content?.find((c) => c.type === 'text')?.text?.value
    if (text) return text
  }
  return undefined
}

/** The conversation from what is already on disk; never a network call. */
async function localMessages(threadId: string): Promise<Messages> {
  const open = getActiveMessages(threadId)
  if (open.length > 0) return open
  try {
    return activePathOf(
      await getServiceHub().messages().fetchMessages(threadId),
      useThreads.getState().threads[threadId]?.metadata
    )
  } catch {
    return []
  }
}

/**
 * The summary line of a chat's preview card: two written sentences on what the
 * chat is about and where it stands, asked for when the card opens, and only of
 * a model on this machine (a hover never sends a chat to a remote provider).
 * Without one, what is already on disk: the first thing the user said and how
 * many messages there are.
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
  const { t } = useTranslation()
  const { summary, loading } = usePreviewSummary(
    `${threadId}\u0000${updated ?? ''}`,
    open,
    async () => titleTranscript(await localMessages(threadId))
  )
  const [local, setLocal] = useState<{ first?: string; count: number }>()
  useEffect(() => {
    if (!open) return
    let current = true
    void localMessages(threadId).then((messages) => {
      if (current)
        setLocal({ first: firstUserText(messages), count: messages.length })
    })
    return () => {
      current = false
    }
  }, [open, threadId, updated])

  const shown = summary ?? fallback ?? local?.first
  const count = !summary && local?.count ? local.count : 0
  if (!shown && !count) return null
  return (
    <div data-testid="row-preview-summary-block" className="mt-2">
      {shown && (
        <p
          data-testid="row-preview-summary"
          className={`rounded-lg bg-muted px-2.5 py-2 text-xs leading-relaxed text-secondary-foreground${
            summary ? '' : ' line-clamp-4'
          }${loading && !summary ? ' opacity-60' : ''}`}
        >
          {shown}
        </p>
      )}
      {count > 0 && (
        <p
          data-testid="row-preview-count"
          className="mt-1 text-[11px] text-subtle-foreground"
        >
          {t('common:previewMessageCount', { count })}
        </p>
      )}
    </div>
  )
}
