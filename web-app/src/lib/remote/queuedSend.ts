// A phone's message with attachments, queued while its conversation was busy,
// sent once the conversation is idle again: through the conversation's own
// composer, as a phone's send that arrived while idle is.

import { useChatAttachments } from '@/hooks/useChatAttachments'
import type { QueuedAttachments } from '@/stores/message-queue-store'
import type { Attachment } from '@/types/attachment'
import { composerFor } from './composer'

/** Documents a phone staged per conversation, until its send. */
const phoneStaged = new Map<string, Set<string>>()

/** Stage documents in the conversation's composer, read at send time. */
export function stageComposerDocs(id: string, docs: Attachment[]): void {
  // Merged: a second staging before the send must not forget the first (P2D-016).
  const staged = phoneStaged.get(id) ?? new Set<string>()
  for (const d of docs) staged.add(d.path ?? '')
  phoneStaged.set(id, staged)
  useChatAttachments.getState().setAttachments(id, (prev) => [
    ...prev,
    ...docs.filter((d) => !prev.some((x) => x.path === d.path)),
  ])
}

/**
 * After the send: Cowork's submit reads staged documents but does not clear
 * them (its composer does); take back what the phone staged so it is not
 * resent.
 */
export function unstageComposerDocs(kind: 'chat' | 'cowork', id: string): void {
  const staged = phoneStaged.get(id)
  if (kind === 'cowork' && staged) {
    useChatAttachments
      .getState()
      .setAttachments(id, (prev) =>
        prev.filter((a) => !a.path || !staged.has(a.path))
      )
  }
  phoneStaged.delete(id)
}

/**
 * Send a queued message that carries attachments through the conversation's
 * composer. False when that conversation has no composer mounted, so the
 * caller can keep the message.
 */
export async function sendQueuedViaComposer(
  kind: 'chat' | 'cowork',
  id: string,
  text: string,
  attachments: QueuedAttachments
): Promise<boolean> {
  const entry = composerFor(kind, id)
  if (!entry) return false
  if (attachments.docs.length) stageComposerDocs(id, attachments.docs)
  try {
    if (attachments.files.length) await entry.send(text, attachments.files)
    else await entry.send(text)
  } finally {
    unstageComposerDocs(kind, id)
  }
  return true
}

/** Test helper. */
export function resetStagedDocs() {
  phoneStaged.clear()
}
