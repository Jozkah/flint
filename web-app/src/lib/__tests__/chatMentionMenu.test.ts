import { describe, expect, it } from 'vitest'
import {
  fuzzyScore,
  rankConversations,
  relativeAge,
} from '@/lib/chatMentionMenu'
import { rankReferences, type ReferenceSources } from '@/lib/referenceMenu'
import type { ConversationEntry } from '@/lib/chatMentions'

const NOW = Date.UTC(2026, 9, 17, 12)
const DAY = 86_400_000

const conv = (over: Partial<ConversationEntry> & { id: string; title: string }): ConversationEntry => ({
  kind: 'chat',
  updated: NOW - DAY,
  ...over,
})

const entries: ConversationEntry[] = [
  conv({ id: 'chat00000001aaaa', title: 'Release notes', updated: NOW - 3.5 * DAY, messageCount: 12, project: 'Flint' }),
  conv({ id: 'chat00000002bbbb', title: 'Notes on release planning', updated: NOW - 1 * DAY }),
  conv({ id: 'sess00000003cccc', title: 'Fix login', kind: 'session', updated: NOW - 2 * DAY, project: 'webapp' }),
  conv({ id: 'room00000004dddd', title: 'Pricing debate', kind: 'room', updated: NOW - 3 * DAY }),
  conv({ id: 'chat00000005eeee', title: 'Old archived', updated: NOW, archived: true }),
]

describe('fuzzyScore', () => {
  it('orders exact, prefix, word start, substring and subsequence', () => {
    const s = (q: string, t: string) => fuzzyScore(q, t)
    expect(s('release', 'Release')).toBeGreaterThan(s('rel', 'Release notes'))
    expect(s('rel', 'Release notes')).toBeGreaterThan(s('note', 'Release notes'))
    expect(s('note', 'Release notes')).toBeGreaterThan(s('eas', 'Release notes'))
    expect(s('eas', 'Release notes')).toBeGreaterThan(s('rln', 'Release notes'))
    expect(s('xyz', 'Release notes')).toBe(0)
    // Scattered letters are not a match.
    expect(s('rel', 'Radar feed retry policy')).toBe(0)
  })
})

describe('rankConversations', () => {
  it('ranks by title match, then recency', () => {
    const out = rankConversations('release', entries, { now: NOW })
    // "Release notes" is a prefix match; "Notes on release planning" only a
    // word-start match, though it is a little more recent.
    expect(out.map((e) => e.name)).toEqual(['Release notes', 'Notes on release planning'])
  })

  it('with no query lists the most recent first, and never the archived or current one', () => {
    const out = rankConversations('', entries, { now: NOW, excludeId: 'chat00000002bbbb' })
    expect(out.map((e) => e.name)).toEqual(['Fix login', 'Pricing debate', 'Release notes'])
  })

  it('recency lifts one of two equal matches', () => {
    const a = conv({ id: 'a0000000000aaaaa', title: 'Plan', updated: NOW - 40 * DAY })
    const b = conv({ id: 'b0000000000bbbbb', title: 'Plan', updated: NOW - 1 * DAY })
    expect(rankConversations('plan', [a, b], { now: NOW }).map((e) => e.conversation?.id)).toEqual([b.id, a.id])
  })

  it('gives each row the token, kind and what the row shows', () => {
    const [row] = rankConversations('login', entries, { now: NOW })
    expect(row).toMatchObject({
      kind: 'session',
      name: 'Fix login',
      detail: 'webapp',
    })
    expect(row.token).toMatch(/^session:fix-login-[a-z0-9]{8}$/)
    expect(row.conversation).toMatchObject({ id: 'sess00000003cccc' })
  })

  it('tells duplicate titles apart: by project when it differs, else by a short id', () => {
    const dup = [
      conv({ id: 'x00000000000aaaa1', title: 'Notes', project: 'A' }),
      conv({ id: 'x00000000000bbbb2', title: 'Notes', project: 'B' }),
      conv({ id: 'x00000000000cccc3', title: 'Plan' }),
      conv({ id: 'x00000000000dddd4', title: 'Plan' }),
    ]
    const out = rankConversations('', dup, { now: NOW })
    const labels = Object.fromEntries(out.map((e) => [e.conversation!.id, e.conversation!.label]))
    expect(labels['x00000000000aaaa1']).toBe('A')
    expect(labels['x00000000000bbbb2']).toBe('B')
    expect(labels['x00000000000cccc3']).toMatch(/^…[a-z0-9]{4}$/)
    expect(labels['x00000000000cccc3']).not.toBe(labels['x00000000000dddd4'])
  })

  it('narrows to one kind', () => {
    expect(rankConversations('', entries, { now: NOW, only: 'room' }).map((e) => e.name)).toEqual(['Pricing debate'])
  })

  it('matches the project and the preview', () => {
    const out = rankConversations('webapp', entries, { now: NOW })
    expect(out.map((e) => e.name)).toEqual(['Fix login'])
  })
})

describe('rankReferences with conversations', () => {
  const sources: ReferenceSources = {
    files: [{ path: 'src/release.ts', name: 'release.ts', kind: 'file', extension: 'ts' }],
    skills: [{ name: 'release-skill' }],
    agents: [],
    aliases: [],
    conversations: entries,
    currentConversationId: 'chat00000002bbbb',
  }

  it('@ adds a Chats group after the other kinds', () => {
    const kinds = rankReferences('release', sources).map((e) => e.kind)
    expect(kinds).toEqual(['skill', 'file', 'chat'])
    expect(kinds).not.toContain('room')
  })

  it('# lists only conversations', () => {
    const out = rankReferences('', sources, 50, '#')
    expect(out.every((e) => ['chat', 'session', 'room'].includes(e.kind))).toBe(true)
    expect(out.map((e) => e.name)).not.toContain('Notes on release planning') // the current one
  })

  it('# with a query ranks by title', () => {
    expect(rankReferences('login', sources, 50, '#').map((e) => e.name)).toEqual(['Fix login'])
  })

  it('a kind prefix narrows to that kind', () => {
    expect(rankReferences('room:', sources).map((e) => e.name)).toEqual(['Pricing debate'])
    expect(rankReferences('skill:rel', sources).map((e) => e.kind)).toEqual(['skill'])
  })

  it('the @ group is capped so it cannot crowd out files', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      conv({ id: `many${String(i).padStart(10, '0')}`, title: `Topic ${i}` })
    )
    const out = rankReferences('', { ...sources, conversations: many })
    expect(out.filter((e) => e.kind === 'chat')).toHaveLength(8)
    expect(out.filter((e) => e.kind !== 'chat').length).toBeGreaterThan(0)
  })

  it('has no conversations without sources, and the old behaviour is unchanged', () => {
    const { conversations: _c, currentConversationId: _i, ...rest } = sources
    expect(rankReferences('release', rest).map((e) => e.kind)).toEqual(['skill', 'file'])
    expect(rankReferences('', rest, 50, '#')).toEqual([])
  })
})

describe('relativeAge', () => {
  it('reads recent times relatively and old ones as a date', () => {
    expect(relativeAge(NOW - 5 * 60_000, NOW, 'en')).toMatch(/5 min/)
    expect(relativeAge(NOW - 3 * DAY, NOW, 'en')).toMatch(/3 days/)
    expect(relativeAge(NOW - 40 * DAY, NOW, 'en')).toMatch(/[A-Z][a-z]{2} \d+/)
  })
})
