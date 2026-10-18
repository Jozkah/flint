/**
 * What the composer tells the user about the mentions in a draft: for each
 * `@chat:` / `@session:` / `@room:` token, which conversation it names and
 * how much of it will be included (docs/CHAT_MENTIONS.md). Pure over the entry
 * list and a loader, so it can be tested; the hook that calls it debounces.
 */
import {
  MENTION_LIMITS,
  buildExcerpt,
  matchMention,
  parseMention,
  type ConversationEntry,
  type ConversationMessage,
  type ConversationSnapshot,
  type MentionKind,
} from '@/lib/chatMentions'
import { parsePromptForReferences } from '@/lib/path-references'

export type MentionPreview = {
  /** The token after `@`, as typed. */
  token: string
  kind: MentionKind
  status: 'ok' | 'missing' | 'self' | 'over-cap'
  id?: string
  title?: string
  messages?: number
  chars?: number
  summary: boolean
  /** The last few messages, clipped, for the hover card. */
  recent?: { role: ConversationMessage['role']; speaker?: string; text: string }[]
}

const RECENT = 3
const RECENT_CHARS = 160

const clip = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > RECENT_CHARS ? `${flat.slice(0, RECENT_CHARS - 1)}…` : flat
}

export async function previewMentions(
  text: string,
  entries: readonly ConversationEntry[],
  load: (
    entry: Pick<ConversationEntry, 'kind' | 'id'>
  ) => Promise<ConversationSnapshot | null>,
  currentId?: string,
  budget?: number
): Promise<MentionPreview[]> {
  const out: MentionPreview[] = []
  const seen = new Set<string>()
  const missingTokens = new Set<string>()
  let counted = 0
  for (const ref of parsePromptForReferences(text)) {
    const parsed = parseMention(ref)
    if (!parsed) continue
    const token = ref
    const base = { token, kind: parsed.kind, summary: parsed.summary }
    const match = matchMention(parsed, entries)
    if (!match.ok) {
      // The same unmatched token typed twice is one chip, not two.
      if (missingTokens.has(token)) continue
      missingTokens.add(token)
      out.push({ ...base, status: 'missing' })
      continue
    }
    const { entry } = match
    const key = `${entry.kind}:${entry.id}`
    if (seen.has(key)) continue
    seen.add(key)
    if (entry.id === currentId) {
      out.push({ ...base, status: 'self', id: entry.id, title: entry.title })
      continue
    }
    counted += 1
    if (counted > MENTION_LIMITS.maxMentions) {
      out.push({ ...base, status: 'over-cap', id: entry.id, title: entry.title })
      continue
    }
    let snap: ConversationSnapshot | null = null
    try {
      snap = await load(entry)
    } catch {
      snap = null
    }
    if (!snap) {
      out.push({ ...base, status: 'missing', id: entry.id, title: entry.title })
      continue
    }
    const excerpt = buildExcerpt(snap, { budget })
    out.push({
      ...base,
      status: 'ok',
      id: entry.id,
      title: entry.title,
      messages: excerpt.messages,
      chars: excerpt.chars,
      recent: snap.messages
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
        .slice(-RECENT)
        .map((m) => ({ role: m.role, speaker: m.speaker, text: clip(m.text) })),
    })
  }
  return out
}

/** The prompt with one mention token taken out, and the gap it leaves closed. */
export function removeMention(text: string, token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')
  return text
    .replace(new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_.-])[ \\t]?`, 'g'), '$1')
    .replace(/[ \t]+$/gm, '')
}

/** The prompt with one mention switched between excerpt and `#summary`. */
export function toggleSummary(text: string, token: string): string {
  const base = token.replace(/#summary$/, '')
  const next = token.endsWith('#summary') ? base : `${base}#summary`
  const escaped = token.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')
  return text.replace(
    new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_.-])`, 'g'),
    `$1@${next}`
  )
}
