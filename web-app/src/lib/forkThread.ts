import { ulid } from 'ulidx'
import type { ThreadMessage } from '@janhq/core'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useMessages } from '@/hooks/useMessages'
import { useThreads } from '@/hooks/useThreads'
import { computeActivePath } from '@/lib/message-branching'

/**
 * Fork a chat: a new conversation that starts as a copy of this one, up to a
 * message (or all of it), and goes its own way from there.
 *
 * Only the branch currently shown is copied, linearly: the other versions of an
 * edited or regenerated message stay with the original. The copy keeps the
 * model, the assistant, the project and the attached folders; it does not keep
 * documents embedded for search (those belong to the original conversation) or
 * anything Jev routed for a specific message.
 */

/** Per-message metadata that only makes sense inside the original conversation. */
const MESSAGE_METADATA_DROPPED = ['parentId', 'activeChildId']
/** Thread metadata the fork does not inherit. */
const THREAD_METADATA_KEPT = ['project', 'folders']

export const FORK_TITLE_SUFFIX = ' (fork)'

/** The forked chat's title: the original's, marked once however often it is forked. */
export function forkTitle(title: string | undefined): string {
  const base = (title ?? '').trim() || 'New Thread'
  return base.endsWith(FORK_TITLE_SUFFIX) ? base : `${base}${FORK_TITLE_SUFFIX}`
}

/** The messages a fork copies: the shown branch, cut after `upToMessageId` when given. */
export function messagesToFork(
  all: readonly ThreadMessage[],
  upToMessageId?: string
): ThreadMessage[] {
  let path = computeActivePath([...all])
  if (upToMessageId) {
    const at = path.findIndex((m) => m.id === upToMessageId)
    if (at >= 0) path = path.slice(0, at + 1)
  }
  return path
}

/**
 * Returns the new thread's id, or `null` when there is nothing to fork (a
 * temporary chat, an unknown thread, no messages).
 */
export async function forkThread(
  threadId: string,
  upToMessageId?: string
): Promise<string | null> {
  if (threadId === TEMPORARY_CHAT_ID) return null
  const threads = useThreads.getState()
  const source = threads.threads[threadId]
  // A chat that never picked a model has nothing for the copy to run on.
  if (!source || !source.model || source.metadata?.isTemporary) return null

  const copied = messagesToFork(useMessages.getState().getMessages(threadId), upToMessageId)
  if (copied.length === 0) return null

  const project = source.metadata?.project as
    | { id: string; name: string; updated_at: number }
    | undefined
  const created = await threads.createThread(
    source.model,
    forkTitle(source.title),
    source.assistants?.[0],
    project
  )

  // The rest of what the conversation carried that a fork should keep.
  const kept: Record<string, unknown> = {}
  for (const key of THREAD_METADATA_KEPT) {
    if (source.metadata?.[key] !== undefined) kept[key] = source.metadata[key]
  }
  useThreads.getState().updateThread(created.id, {
    assistants: source.assistants,
    metadata: { ...(created.metadata ?? {}), ...kept },
  })

  for (const message of copied) {
    const metadata = { ...((message.metadata ?? {}) as Record<string, unknown>) }
    for (const key of MESSAGE_METADATA_DROPPED) delete metadata[key]
    useMessages.getState().addMessage({
      ...message,
      id: ulid(),
      thread_id: created.id,
      metadata,
    })
  }
  return created.id
}
