/**
 * The composer's two calls into conversation mentions (docs/CHAT_MENTIONS.md):
 * the menu's source list, and resolving a draft's mentions on send. Kept out
 * of ChatInput so that file only wires them in.
 */
import { parsePromptForReferences } from '@/lib/path-references'
import {
  joinMentionBlocks,
  parseMention,
  resolveMentions,
  type ResolvedMentions,
} from '@/lib/chatMentions'
import {
  listConversationsAsync,
  loadSnapshot,
  messagingHintFor,
} from '@/lib/chatMentionSources'

export type MentionSendOptions = {
  /** The conversation being written in; it cannot mention itself. */
  currentId?: string
  /** Cowork or an agent run with tools: sessions are described as messageable. */
  agentSurface?: boolean
  /** Writes a summary of a `#summary` mention. Absent: the excerpt is used. */
  summarize?: (transcript: string) => Promise<string>
}

/** The fenced blocks and records for every mention in `text`; `[]` when none. */
export async function resolvePromptMentions(
  text: string,
  opts: MentionSendOptions = {}
): Promise<ResolvedMentions> {
  // `parsePromptForReferences` already skips fenced and inline code and
  // escaped `\@`, so a mention pasted inside code is never resolved.
  const refs = parsePromptForReferences(text).filter((r) => parseMention(r))
  if (refs.length === 0) return { blocks: [], mentions: [], notes: [] }
  return resolveMentions(refs, {
    currentId: opts.currentId,
    entries: await listConversationsAsync(),
    load: loadSnapshot,
    messagingHint: opts.agentSurface ? (e) => messagingHintFor(e) : undefined,
    summarize: opts.summarize,
  })
}

/** The message as sent: the user's text, then the fenced blocks. */
export const withMentionBlocks = (
  text: string,
  resolved: Pick<ResolvedMentions, 'blocks'>
): string => joinMentionBlocks(text, resolved.blocks)
