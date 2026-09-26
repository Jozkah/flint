import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EventEnvelope, EventsPage } from '@/lib/eventLog'
import {
  backfillPrClaims,
  recordSessionPr,
  sessionPrFromTool,
} from '@/lib/prClaimBackfill'
import { sessionPrStatuses, usePrStatusStore } from '@/stores/pr-status-store'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => ({ kind: 'failed', message: 'offline' })),
}))

const A = 'aaaaaaaa-0000-0000-0000-000000000001'
const B = 'bbbbbbbb-0000-0000-0000-000000000002'

// The attached checkout is on fix/stock-change-delta-detection; the PR's head
// is another branch.
const CREATE_34 =
  '$ gh pr create --repo stockpath/KewScraper --base master --head fix/storage-go-concurrent-map-race --title "Fix map race"\nhttps://github.com/stockpath/KewScraper/pull/34\n'

const reset = () =>
  usePrStatusStore.setState({
    byFolder: {},
    byUrl: {},
    claims: {},
    backfilled: false,
    sessionPrs: {},
    sessionPrsBackfilled: false,
  })

describe('session pull requests', () => {
  beforeEach(reset)

  it('reads a created pull request whatever branch the folder is on', () => {
    expect(sessionPrFromTool('git', { command: 'gh pr create' }, CREATE_34, 't')).toEqual({
      url: 'https://github.com/stockpath/KewScraper/pull/34',
      number: 34,
      repo: 'stockpath/KewScraper',
      head: 'fix/storage-go-concurrent-map-race',
      at: 't',
    })
    expect(
      sessionPrFromTool('create_pull_request', {}, '{"html_url":"https://github.com/o/r/pull/7"}')?.number
    ).toBe(7)
    expect(sessionPrFromTool('git', {}, '$ git push\nhttps://github.com/o/r/pull/9')).toBeNull()
    expect(sessionPrFromTool('bash', {}, 'https://github.com/o/r/pull/9')).toBeNull()
  })

  it('records it on the creating session only, and keeps it persisted', () => {
    recordSessionPr(A, 'git', { command: 'gh pr create' }, CREATE_34)
    const s = usePrStatusStore.getState()
    expect(s.sessionPrs[A]?.map((p) => p.number)).toEqual([34])
    expect(s.sessionPrs[B]).toBeUndefined()
    // Shown latest first, from the record until gh answers.
    expect(sessionPrStatuses(s.sessionPrs[A]!, {})[0]).toMatchObject({
      number: 34,
      state: 'open',
      head: 'fix/storage-go-concurrent-map-race',
    })
    const persist = (usePrStatusStore as unknown as {
      persist: { getOptions: () => { partialize: (s: unknown) => Record<string, unknown> } }
    }).persist
    const saved = persist.getOptions().partialize(usePrStatusStore.getState())
    expect(saved.sessionPrs).toEqual(s.sessionPrs)
  })

  it('backfills #34/#35-style pull requests from the event log once', async () => {
    const ev = (session: string, seq: number, output: string): EventEnvelope => ({
      v: 1,
      id: `e${seq}`,
      session,
      run: 'r',
      invocation: 'i',
      seq,
      at: `2026-09-26T12:${String(seq).padStart(2, '0')}:00Z`,
      kind: 'tool.succeeded',
      payload: { tool: 'git', output },
      redactions: [],
    })
    const pages: Record<string, EventEnvelope[]> = {
      [A]: [ev(A, 1, CREATE_34)],
      [B]: [ev(B, 2, '$ gh pr create --base master\nhttps://github.com/stockpath/KewScraper/pull/35')],
    }
    const list = vi.fn(async (id: string): Promise<EventsPage> => {
      const events = pages[id] ?? []
      return { events, lastSeq: events.at(-1)?.seq ?? 0, truncated: false }
    })
    const sessions = [A, B].map((id) => ({ id, folder: 'C:\\KewScraper' }))
    await backfillPrClaims(sessions, list)
    const s = usePrStatusStore.getState()
    expect(s.sessionPrs[A]?.map((p) => p.number)).toEqual([34])
    expect(s.sessionPrs[B]?.map((p) => p.number)).toEqual([35])
    expect(s.sessionPrsBackfilled).toBe(true)
    list.mockClear()
    usePrStatusStore.setState({ backfilled: true })
    await backfillPrClaims(sessions, list)
    expect(list).not.toHaveBeenCalled()
  })
})
