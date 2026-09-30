import type { ThreadMessage } from '@janhq/core'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useMessages } from '@/hooks/useMessages'
import { useThreads } from '@/hooks/useThreads'
import { regenerateThreadTitle } from '@/lib/thread-title-summarizer'
import { AUTO_TITLE_SOURCE_KEY, firstUserText } from '@/lib/threadAutoTitle'

/** Turns kept from each end of a long chat, so the title reflects all of it. */
const HEAD_TURNS = 3
const TAIL_TURNS = 6
const PER_TURN_CHARS = 400

const textOf = (m: ThreadMessage): string =>
  (m.content ?? [])
    .map((c) => c?.text?.value ?? '')
    .join('')
    .trim()

/**
 * The conversation as text for the title model: the opening turns and the
 * latest ones, each trimmed, so a long chat is judged by what it is about and
 * not only by its last reply.
 */
export function titleTranscript(messages: readonly ThreadMessage[]): string {
  return transcriptOf(
    messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        speaker: m.role === 'assistant' ? 'Assistant' : 'User',
        text: textOf(m),
      }))
  )
}

/** The same, from turns that already carry a speaker label and plain text. */
export function transcriptOf(
  turns: readonly { speaker: string; text: string }[]
): string {
  const picked =
    turns.length <= HEAD_TURNS + TAIL_TURNS
      ? turns
      : [...turns.slice(0, HEAD_TURNS), ...turns.slice(-TAIL_TURNS)]
  return picked
    .map(({ speaker, text }) => {
      const clean = text.trim()
      if (!clean) return ''
      const cut = clean.length > PER_TURN_CHARS ? `${clean.slice(0, PER_TURN_CHARS)}...` : clean
      return `${speaker}: ${cut}`
    })
    .filter(Boolean)
    .join('\n\n')
}

export type RegenerateResult = 'done' | 'empty' | 'failed'

/**
 * Give a chat a new title from what it is about, replacing the current one.
 * A title chosen by hand is replaced too: the user asked for this. The chat is
 * then marked as titled from its first message, so the automatic title does
 * not run over the result on the next reply.
 */
export async function regenerateTitle(threadId: string): Promise<RegenerateResult> {
  let messages = useMessages.getState().getMessages(threadId)
  if (messages.length === 0) {
    try {
      messages = await getServiceHub().messages().fetchMessages(threadId)
    } catch {
      return 'failed'
    }
  }
  const transcript = titleTranscript(messages)
  if (!transcript) return 'empty'
  const title = await regenerateThreadTitle(
    transcript,
    new AbortController().signal,
    threadId
  )
  if (!title) return 'failed'
  const latest = useThreads.getState().threads[threadId]
  if (!latest) return 'failed'
  const { titleSetManually: _manual, ...metadata } = latest.metadata ?? {}
  void _manual
  useThreads.getState().updateThread(threadId, {
    title,
    metadata: { ...metadata, [AUTO_TITLE_SOURCE_KEY]: firstUserText(messages) },
  })
  return 'done'
}
