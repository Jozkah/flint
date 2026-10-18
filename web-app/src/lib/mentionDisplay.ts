/**
 * How the composer shows conversation mentions (docs/CHAT_MENTIONS.md): where
 * the `@chat:` / `@session:` / `@room:` tokens sit in a draft, so the editor can
 * draw them as pills, and what the included context costs in tokens. Display
 * only: the token text and what is sent stay exactly as before.
 */
import { MessagesSquare, SquareTerminal, Users } from 'lucide-react'
import { estimateTokensForChars } from '@/lib/context-manager'
import type { MentionKind } from '@/lib/chatMentions'
import type { MentionPreview } from '@/lib/chatMentionPreview'

/** The icon of each kind, wherever a mention is drawn. */
export const MENTION_ICON: Record<MentionKind, typeof MessagesSquare> = {
  chat: MessagesSquare,
  session: SquareTerminal,
  room: Users,
}

export type MentionRange = {
  /** Offset of the `@`. */
  start: number
  /** Offset just past the token. */
  end: number
  /** The token after `@`, as the send path reads it (`chat:slug-id#summary`). */
  token: string
  kind: MentionKind
}

// The conversation branch of `REFERENCE_PATTERN` (lib/path-references.ts), so a
// pill covers exactly the text the send path resolves.
const TOKEN =
  /(^|[^A-Za-z0-9_])@((chat|session|room):[A-Za-z0-9][A-Za-z0-9_.-]*(?:#summary)?)/g

/** Every mention token in `text`; an escaped `\@` is not one. */
export function findMentionRanges(text: string): MentionRange[] {
  const out: MentionRange[] = []
  TOKEN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(text)) !== null) {
    if (m[1] === '\\') continue
    const start = m.index + m[1].length
    out.push({
      start,
      end: start + 1 + m[2].length,
      token: m[2],
      kind: m[3] as MentionKind,
    })
  }
  return out
}

/** A summary is written within this many output tokens (compactionSummarizer). */
export const SUMMARY_TOKENS = 1024

/** Rough tokens one mention adds: its excerpt, or at most a summary's length. */
export function mentionTokens(chars: number, summary: boolean): number {
  const excerpt = estimateTokensForChars(chars)
  return summary ? Math.min(excerpt, SUMMARY_TOKENS) : excerpt
}

/** Share of the model's window above which the composer warns. */
export const MENTION_WARN_SHARE = 0.25

/** True when the included mentions would take over a quarter of the window. */
export function mentionsTooLarge(
  tokens: number,
  contextWindow: number | null | undefined
): boolean {
  return !!contextWindow && contextWindow > 0
    ? tokens > contextWindow * MENTION_WARN_SHARE
    : false
}

/** `~398` / `~1.2k`, as the status line shows a token count. */
export function compactCount(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    notation: n >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(n)
}

/** Totals of what the resolved mentions add, for the status line. */
export function mentionTotals(previews: readonly MentionPreview[]) {
  let messages = 0
  let tokens = 0
  let excerpts = 0
  for (const p of previews) {
    if (p.status !== 'ok') continue
    messages += p.messages ?? 0
    tokens += mentionTokens(p.chars ?? 0, p.summary)
    if (!p.summary) excerpts += 1
  }
  return { messages, tokens, excerpts }
}
