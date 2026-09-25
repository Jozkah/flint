/**
 * When a chat's title should be generated automatically.
 *
 * The title helper used to run on the first reply and again every few
 * replies, and onFinish fires once per agent step, so a tool-using turn could
 * re-title the same chat several times in seconds. The rule now: a chat is
 * titled once, from its first user message, and again only when that first
 * message changes (the user edited it and resent). A title the user set by
 * hand is never replaced.
 */

/** Thread metadata key holding the first user message the title came from. */
export const AUTO_TITLE_SOURCE_KEY = 'autoTitleSource'

type TitleMessage = {
  role: string
  content?: Array<{ text?: { value?: string } } | null | undefined>
}

/** The text of the chat's first user message, trimmed, or '' when none. */
export function firstUserText(messages: readonly TitleMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  return (
    first?.content
      ?.map((c) => c?.text?.value ?? '')
      .join('')
      .trim() ?? ''
  )
}

/** Titles being generated right now, so overlapping onFinish calls skip. */
const inFlight = new Map<string, string>()

export type AutoTitleDecision =
  | { kind: 'skip' }
  /** Record the source without generating (a chat titled before this rule). */
  | { kind: 'adopt'; source: string }
  | { kind: 'generate'; source: string }

export function decideAutoTitle(args: {
  threadId: string
  enabled: boolean
  metadata: Record<string, unknown> | undefined
  messages: readonly TitleMessage[]
}): AutoTitleDecision {
  const { threadId, enabled, metadata, messages } = args
  if (!enabled || metadata?.titleSetManually) return { kind: 'skip' }
  const source = firstUserText(messages)
  if (!source) return { kind: 'skip' }
  if (inFlight.get(threadId) === source) return { kind: 'skip' }
  const recorded = metadata?.[AUTO_TITLE_SOURCE_KEY]
  if (typeof recorded === 'string') {
    return recorded === source ? { kind: 'skip' } : { kind: 'generate', source }
  }
  // No record: a new chat on its first reply gets a title; an older chat that
  // already has replies was titled under the previous rule, so keep its title.
  const replies = messages.filter((m) => m.role === 'assistant').length
  return replies > 1 ? { kind: 'adopt', source } : { kind: 'generate', source }
}

/** Mark a title generation for this source as running. */
export function beginAutoTitle(threadId: string, source: string): void {
  inFlight.set(threadId, source)
}

/** Clear the running mark (only if it is still this source's). */
export function endAutoTitle(threadId: string, source: string): void {
  if (inFlight.get(threadId) === source) inFlight.delete(threadId)
}
