import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EventEnvelope, EventsPage } from '@/lib/eventLog'
import { backfillPrClaims, collectPrClaims, createdPrNumber } from '@/lib/prClaimBackfill'
import { claimKey, usePrStatusStore } from '@/stores/pr-status-store'

const OPENER = '8411d403-b788-4b60-b78e-45672ae39826'
const OTHER = '3a6cdcf3-04bc-4ab2-9f74-439383b776a3'
const FOLDER = 'C:\\Users\\Jozkah\\Desktop\\Coding\\KewScraper'

const event = (
  session: string,
  seq: number,
  payload: Record<string, unknown>,
  kind = 'tool.succeeded'
): EventEnvelope => ({
  v: 1,
  id: `e${seq}`,
  session,
  run: 'r',
  invocation: 'i',
  seq,
  at: `2026-09-26T12:${String(seq).padStart(2, '0')}:00Z`,
  kind,
  payload,
  redactions: [],
})

// Shaped like session 8411d403's recorded `gh pr create`.
const ghCreate = event(OPENER, 57, {
  tool: 'git',
  output:
    '$ gh pr create --repo stockpath/KewScraper --base master --head fix/stock-change-delta-detection --title "Fix stock_change spam" --body "Fixes #9 and #4."\nhttps://github.com/stockpath/KewScraper/pull/31\n',
})

const page = (events: EventEnvelope[]): EventsPage => ({
  events,
  lastSeq: events.at(-1)?.seq ?? 0,
  truncated: false,
})

describe('PR claim backfill', () => {
  beforeEach(() => usePrStatusStore.setState({ byFolder: {}, claims: {}, backfilled: false, sessionPrsBackfilled: true }))

  it('reads the pull request a gh pr create or create_pull_request opened', () => {
    expect(createdPrNumber(ghCreate)).toBe(31)
    expect(
      createdPrNumber(
        event(OPENER, 2, { tool: 'create_pull_request', output: '{"html_url":"https://github.com/o/r/pull/7"}' })
      )
    ).toBe(7)
    // A view names a pull request it did not open; a failed create opened none.
    expect(
      createdPrNumber(event(OTHER, 3, { tool: 'git', output: '$ gh pr view 31\nhttps://github.com/o/r/pull/31' }))
    ).toBeNull()
    expect(createdPrNumber({ ...ghCreate, kind: 'tool.failed' })).toBeNull()
  })

  it('claims PR #31 for session 8411d403, not the session sharing its checkout', async () => {
    const list = vi.fn(async (session: string) =>
      page(session === OPENER ? [ghCreate] : [event(OTHER, 1, { tool: 'git', output: '$ gh pr list\n#31' })])
    )
    await backfillPrClaims(
      [
        { id: OTHER, folder: FOLDER },
        { id: OPENER, folder: FOLDER },
      ],
      list
    )
    const s = usePrStatusStore.getState()
    expect(s.claims).toEqual({ [claimKey(FOLDER, 31)]: OPENER })
    expect(s.backfilled).toBe(true)
    // Once only.
    await backfillPrClaims([{ id: OPENER, folder: FOLDER }], list)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('keeps live claims and follows truncated pages', async () => {
    usePrStatusStore.setState({ claims: { [claimKey(FOLDER, 31)]: 'live' } })
    const list = vi
      .fn()
      .mockResolvedValueOnce({ events: [], lastSeq: 50, truncated: true })
      .mockResolvedValueOnce(page([ghCreate]))
    const claims = await collectPrClaims([{ id: OPENER, folder: FOLDER }], list)
    expect(list).toHaveBeenLastCalledWith(OPENER, 50)
    expect(claims).toEqual({ [claimKey(FOLDER, 31)]: OPENER })
    usePrStatusStore.getState().addClaims(claims)
    expect(usePrStatusStore.getState().claims[claimKey(FOLDER, 31)]).toBe('live')
  })
})
