import { monotonicFactory } from 'ulidx'
import type { ThreadMessage } from '@janhq/core'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useMessages } from '@/hooks/useMessages'
import { useThreads } from '@/hooks/useThreads'
import { activePathOf } from '@/lib/message-branching'
import { i18n } from '@/i18n/react-i18next-compat'

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

/** The chat a thread was forked from (`metadata.forkedFrom`), if recorded. */
export function forkParentOf(thread: Pick<Thread, 'metadata'> | undefined): string | null {
  const from = thread?.metadata?.forkedFrom
  return typeof from === 'string' && from ? from : null
}

/** The English suffix, kept so titles forked before it was translated still count as forks. */
export const FORK_TITLE_SUFFIX = ' (fork)'

/** The forked chat's title: the original's, marked once however often it is forked. */
export function forkTitle(title: string | undefined): string {
  const base = (title ?? '').trim() || i18n.t('common:newThread')
  const suffix = i18n.t('chat:fork.titleSuffix')
  return base.endsWith(suffix) || base.endsWith(FORK_TITLE_SUFFIX) ? base : `${base}${suffix}`
}

/** The message to fork from is not on the branch the user is viewing. */
export class ForkBranchError extends Error {
  constructor(messageId: string) {
    super(`Message ${messageId} is not on the shown branch`)
    this.name = 'ForkBranchError'
  }
}

/**
 * The messages a fork copies: the shown branch (the thread's selected root,
 * then each message's active version), cut after `upToMessageId` when given.
 * A message that is not on that branch throws rather than copying another
 * branch in its place (C019).
 */
export function messagesToFork(
  all: readonly ThreadMessage[],
  upToMessageId?: string,
  threadMetadata?: Record<string, unknown> | null
): ThreadMessage[] {
  const path = activePathOf([...all], threadMetadata)
  if (!upToMessageId) return path
  const at = path.findIndex((m) => m.id === upToMessageId)
  if (at < 0) throw new ForkBranchError(upToMessageId)
  return path.slice(0, at + 1)
}

/**
 * Returns the new thread's id, or `null` when there is nothing to fork (a
 * temporary chat, an unknown thread, no messages). Throws ForkBranchError when
 * `upToMessageId` is not on the shown branch.
 */
export async function forkThread(
  threadId: string,
  upToMessageId?: string
): Promise<string | null> {
  if (threadId === TEMPORARY_CHAT_ID) return null
  // The copy takes the source's assistant: load it in full first, a listed
  // summary has no instructions or parameters.
  await useThreads.getState().ensureThreadHydrated?.(threadId)
  const threads = useThreads.getState()
  const source = threads.threads[threadId]
  // A chat that never picked a model has nothing for the copy to run on.
  if (!source || !source.model || source.metadata?.isTemporary) return null

  const copied = messagesToFork(
    useMessages.getState().getMessages(threadId),
    upToMessageId,
    source.metadata
  )
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
    // `forkedFrom`: the chat this one was copied from, so the sidebar can
    // show the copy under it. Display only; absent on chats from before it.
    metadata: { ...(created.metadata ?? {}), ...kept, forkedFrom: source.id },
  })

  // Ids sort in copy order: plain ulid() is random within one millisecond, and
  // a tight loop scrambled the fork's message order (T7-023).
  const nextId = monotonicFactory()
  for (const message of copied) {
    const metadata = { ...((message.metadata ?? {}) as Record<string, unknown>) }
    for (const key of MESSAGE_METADATA_DROPPED) delete metadata[key]
    useMessages.getState().addMessage({
      ...message,
      id: nextId(),
      thread_id: created.id,
      metadata,
    })
  }
  return created.id
}
