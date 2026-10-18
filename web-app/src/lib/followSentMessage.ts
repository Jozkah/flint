import type { StickToBottomContext } from 'use-stick-to-bottom'

/**
 * Bring the transcript to the message just sent and keep following the reply.
 *
 * Sending is a request to see what was sent, wherever the view was: a forked
 * thread opens with its copied history and the view could sit above the end,
 * so the new message and its reply arrived out of sight (C14). Asked now and
 * once more after the message is in the list.
 */
export function followSentMessage(
  ctx: Pick<StickToBottomContext, 'scrollToBottom'> | null
): void {
  if (!ctx) return
  void ctx.scrollToBottom('instant')
  setTimeout(() => void ctx.scrollToBottom('instant'), 0)
}
