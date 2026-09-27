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
    sessionPrsBackfillVersion: 0,
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

  // Shaped like the logged events: the succeeded event has no input, the
  // output echoes the command (body included) and ends with the new URL.
  const REAL_CREATE =
    '$ gh pr create --repo acme/scraper --head fix/race --base master --title "Fix race" --body "Follows https://github.com/acme/scraper/pull/12.\n\nGenerated with [Flint](https://github.com/Jozkah/flint)"\nhttps://github.com/acme/scraper/pull/34'
  const REAL_VIEW =
    '$ gh pr view 35 --repo acme/scraper --json url,state\n{"state":"OPEN","url":"https://github.com/acme/scraper/pull/35"}'

  it('reads the logged gh output, taking the URL gh printed last', () => {
    expect(sessionPrFromTool('git', null, REAL_CREATE)).toMatchObject({ number: 34, repo: 'acme/scraper', head: 'fix/race' })
    expect(sessionPrFromTool('git', null, REAL_VIEW)?.number).toBe(35)
    // The same command through a shell tool.
    expect(sessionPrFromTool('bash', { command: 'gh pr create --fill' }, 'https://github.com/acme/scraper/pull/36')?.number).toBe(36)
    expect(sessionPrFromTool('powershell', { command: 'gh pr view 37' }, 'url: https://github.com/acme/scraper/pull/37')?.number).toBe(37)
  })

  it('reruns the backfill once where version 1 found nothing', async () => {
    usePrStatusStore.setState({ sessionPrsBackfilled: true, sessionPrsBackfillVersion: 0, backfilled: true })
    const e: EventEnvelope = {
      v: 1, id: 'x', session: A, run: 'r', invocation: '', seq: 1, at: '2026-09-26T14:00:00Z',
      kind: 'tool.succeeded', payload: { tool: 'git', input: null, output: REAL_CREATE }, redactions: [],
    }
    const list = vi.fn(async (): Promise<EventsPage> => ({ events: [e], lastSeq: 1, truncated: false }))
    await backfillPrClaims([{ id: A, folder: 'C:\\scraper' }], list)
    expect(usePrStatusStore.getState().sessionPrs[A]?.map((p) => p.number)).toEqual([34])
    expect(usePrStatusStore.getState().sessionPrsBackfillVersion).toBe(2)
    list.mockClear()
    await backfillPrClaims([{ id: A, folder: 'C:\\scraper' }], list)
    expect(list).not.toHaveBeenCalled()
  })

  it('marks a recorded pull request whose status lookup failed', () => {
    const pr = sessionPrFromTool('git', null, REAL_CREATE, 't')!
    const [shown] = sessionPrStatuses([pr], {
      [pr.url]: { lookup: { kind: 'failed', message: 'gh: not authorized' }, at: 1, loading: false },
    })
    expect(shown).toMatchObject({ number: 34, statusError: 'gh: not authorized' })
  })
})
