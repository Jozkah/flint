/**
 * Whether a message should slide in when it appears.
 *
 * Every message of a chat used to animate in together the moment the chat
 * opened, so a long history took most of half a second to come up and the list
 * was scrolled past the top while it did. Messages that were already there when
 * the conversation opened now simply appear; only what arrives afterwards
 * animates. The clock is shared by whichever conversation opened last, which is
 * right for the one in view.
 */
let openedAt = 0

/** Note that a conversation has just been opened (called again on switching). */
export function markConversationOpened(): void {
  openedAt = Date.now()
}

/** How long after opening a conversation its history is still being drawn. */
const SETTLE_MS = 2000

/** A message mounting now is new, not part of the history being drawn. */
export function shouldAnimateEntry(): boolean {
  return Date.now() - openedAt > SETTLE_MS
}
