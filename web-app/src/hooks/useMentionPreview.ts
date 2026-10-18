import { useEffect, useState } from 'react'
import { listConversationsAsync, loadSnapshot } from '@/lib/chatMentionSources'
import { previewMentions, type MentionPreview } from '@/lib/chatMentionPreview'

const HAS_MENTION = /@(chat|session|room):/

/**
 * What the mentions in a draft resolve to, a moment after typing stops. Reads
 * the local stores only; a draft without a mention costs nothing.
 */
export function useMentionPreview(
  prompt: string,
  currentId?: string
): MentionPreview[] {
  const [previews, setPreviews] = useState<MentionPreview[]>([])
  useEffect(() => {
    if (!HAS_MENTION.test(prompt)) {
      setPreviews((p) => (p.length ? [] : p))
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      // The async listing fills the rooms store first; the sync one would
      // call a typed @room: chip missing before the menu or a send did.
      void listConversationsAsync()
        .then((entries) =>
          alive ? previewMentions(prompt, entries, loadSnapshot, currentId) : null
        )
        .then((next) => next && alive && setPreviews(next))
        .catch(() => alive && setPreviews([]))
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [prompt, currentId])
  return previews
}
