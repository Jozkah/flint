import { getServiceHub } from '@/hooks/useServiceHub'
import { getActiveMessages } from '@/hooks/useActiveMessages'
import { useThreads } from '@/hooks/useThreads'
import { activePathOf } from '@/lib/message-branching'
import { titleTranscript } from '@/lib/regenerateTitle'

type Messages = ReturnType<typeof getActiveMessages>

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
 * What a chat's preview card can say from disk alone: the first thing the
 * user said and how many messages there are (the shown versions only).
 */
export async function threadPreviewFacts(
  threadId: string
): Promise<{ first?: string; count: number }> {
  const messages = await localMessages(threadId)
  let first: string | undefined
  for (const m of messages) {
    if (m.role !== 'user') continue
    const text = m.content?.find((c) => c.type === 'text')?.text?.value
    if (text) {
      first = text
      break
    }
  }
  return { first, count: messages.length }
}

/** The chat as text for a written summary, from the shown versions only. */
export async function threadPreviewTranscript(threadId: string): Promise<string> {
  return titleTranscript(await localMessages(threadId))
}
