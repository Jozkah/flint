/**
 * The conversations the `@` and `#` menus offer (docs/CHAT_MENTIONS.md).
 *
 * Ranked by how well the title matches the query, with recency breaking ties
 * and nudging near-equal matches: what you were just talking about comes
 * first. The conversation being written in is never offered. Archived items
 * are not in the live lists the entries are built from, so they are not
 * offered either; an entry that does carry `archived` is dropped here.
 */
import type { ReferenceEntry } from '@/lib/referenceMenu'
import {
  idTag,
  mentionToken,
  type ConversationEntry,
} from '@/lib/chatMentions'

const DAY = 24 * 60 * 60 * 1000

/** 0 for no match, up to 100 for the whole title. */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 10
  const t = text.toLowerCase()
  if (t === query) return 100
  if (t.startsWith(query)) return 85
  if (t.split(/[^a-z0-9]+/).some((word) => word.startsWith(query))) return 75
  if (t.includes(query)) return 60
  // Letters in order, but close together: `rln` finds "Release notes", while
  // `rel` does not match every title that has an r, an e and an l somewhere.
  if (query.length >= 2) {
    let at = 0
    let first = -1
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== query[at]) continue
      if (first === -1) first = i
      if (++at === query.length)
        return i - first + 1 <= query.length * 3 ? 35 : 0
    }
  }
  return 0
}

/** Up to 15 points for something touched today, fading over a few weeks. */
const recencyBoost = (updated: number, now: number) =>
  15 * Math.exp(-Math.max(0, now - updated) / (14 * DAY))

/** "5 min ago", "3 days ago", or a short date once it is a few weeks old. */
export function relativeAge(
  ms: number,
  now = Date.now(),
  locale?: string
): string {
  const ago = Math.max(0, now - ms)
  const rtf = new Intl.RelativeTimeFormat(locale, {
    numeric: 'auto',
    style: 'short',
  })
  if (ago < 60_000) return rtf.format(0, 'second')
  if (ago < 3_600_000) return rtf.format(-Math.round(ago / 60_000), 'minute')
  if (ago < DAY) return rtf.format(-Math.round(ago / 3_600_000), 'hour')
  if (ago < 14 * DAY) return rtf.format(-Math.round(ago / DAY), 'day')
  return new Date(ms).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
  })
}

export type RankConversationsOptions = {
  excludeId?: string
  now?: number
  limit?: number
  /** Only this kind (a `chat:` prefix in the query). */
  only?: ConversationEntry['kind']
}

export function rankConversations(
  query: string,
  entries: readonly ConversationEntry[],
  opts: RankConversationsOptions = {}
): ReferenceEntry[] {
  const q = query.trim().toLowerCase()
  const now = opts.now ?? Date.now()
  const pool = entries.filter(
    (e) =>
      !e.archived &&
      e.id !== opts.excludeId &&
      (!opts.only || e.kind === opts.only)
  )
  // Two rows with one title need something to tell them apart.
  const byTitle = new Map<string, ConversationEntry[]>()
  for (const e of pool) {
    const key = `${e.kind}:${e.title.trim().toLowerCase()}`
    byTitle.set(key, [...(byTitle.get(key) ?? []), e])
  }
  const labelFor = (e: ConversationEntry): string | undefined => {
    const same = byTitle.get(`${e.kind}:${e.title.trim().toLowerCase()}`) ?? []
    if (same.length < 2) return undefined
    const project = e.project?.trim()
    if (project && same.filter((o) => o.project?.trim() === project).length === 1)
      return project
    return `…${idTag(e.id).slice(-4)}`
  }
  return pool
    .map((e) => {
      const s = Math.max(
        fuzzyScore(q, e.title || ''),
        q && (e.project ?? '').toLowerCase().includes(q) ? 25 : 0,
        q && (e.preview ?? '').toLowerCase().includes(q) ? 20 : 0
      )
      return { e, s: s > 0 ? s + recencyBoost(e.updated, now) : 0 }
    })
    .filter(({ s }) => s > 0)
    .sort(
      (a, b) =>
        b.s - a.s || b.e.updated - a.e.updated || a.e.id.localeCompare(b.e.id)
    )
    .slice(0, opts.limit ?? 20)
    .map(
      ({ e }): ReferenceEntry => ({
        kind: e.kind,
        token: mentionToken(e.kind, e.id, e.title),
        name: e.title || '(untitled)',
        detail: e.project,
        conversation: {
          id: e.id,
          updated: e.updated,
          messageCount: e.messageCount,
          preview: e.preview,
          label: labelFor(e),
          live: e.live,
        },
      })
    )
}
