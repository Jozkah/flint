import { describe, it, expect, beforeEach, vi } from 'vitest'
import { pruneOrphanPrRecords } from '@/lib/prClaimBackfill'
import {
  MAX_PRS_PER_SESSION,
  MAX_URL_ENTRIES,
  usePrStatusStore,
  type SessionPr,
} from '@/stores/pr-status-store'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => ({ kind: 'no_pull_request' })),
}))

const pr = (n: number): SessionPr => ({
  url: `https://github.com/o/r/pull/${n}`,
  number: n,
  repo: 'o/r',
  at: new Date(1_700_000_000_000 + n * 1000).toISOString(),
})

const reset = () =>
  usePrStatusStore.setState({
    byFolder: {},
    byUrl: {},
    claims: {},
    backfilled: true,
    sessionPrs: {},
    sessionPrsBackfilled: true,
    sessionPrsBackfillVersion: 2,
  })

describe('pull-request records of deleted sessions', () => {
  beforeEach(reset)

  it('migrates storage written by older builds: orphans dropped on load, live and archived kept', async () => {
    // What an older build left in the persisted blob: records of a deleted
    // session (gone) next to a live one and an archived one.
    usePrStatusStore.setState({
      sessionPrs: { live: [pr(1)], archived: [pr(2)], gone: [pr(3)] },
      claims: { '/a#1': 'live', '/a#2': 'archived', '/a#3': 'gone' },
    })
    await pruneOrphanPrRecords(['live'], async () => ['archived'])
    const s = usePrStatusStore.getState()
    expect(Object.keys(s.sessionPrs).sort()).toEqual(['archived', 'live'])
    expect(s.claims).toEqual({ '/a#1': 'live', '/a#2': 'archived' })
    // The persisted shape is unchanged: same keys, nothing to version.
    const persisted = usePrStatusStore.persist.getOptions().partialize!(s) as object
    expect(Object.keys(persisted).sort()).toEqual([
      'backfilled',
      'claims',
      'sessionPrs',
      'sessionPrsBackfillVersion',
      'sessionPrsBackfilled',
    ])
  })

  it('drops nothing before sessions load or when the archive cannot be read', async () => {
    usePrStatusStore.setState({ sessionPrs: { gone: [pr(3)] }, claims: { '/a#3': 'gone' } })
    await pruneOrphanPrRecords([], async () => [])
    await pruneOrphanPrRecords(['live'], async () => {
      throw new Error('no archive')
    })
    expect(usePrStatusStore.getState().sessionPrs.gone).toHaveLength(1)
    expect(usePrStatusStore.getState().claims['/a#3']).toBe('gone')
  })

  it('forgets a deleted session at once and caps each list', () => {
    const many = Array.from({ length: MAX_PRS_PER_SESSION + 5 }, (_, i) => pr(i + 1))
    usePrStatusStore.getState().addSessionPrs({ s: many })
    const list = usePrStatusStore.getState().sessionPrs.s
    expect(list).toHaveLength(MAX_PRS_PER_SESSION)
    expect(list[list.length - 1].number).toBe(MAX_PRS_PER_SESSION + 5)
    usePrStatusStore.getState().addClaims({ '/a#1': 's', '/a#9': 'other' })
    usePrStatusStore.getState().forgetSession('s')
    expect(usePrStatusStore.getState().sessionPrs.s).toBeUndefined()
    expect(usePrStatusStore.getState().claims).toEqual({ '/a#9': 'other' })
  })

  it('keeps live statuses bounded', async () => {
    for (let i = 0; i < MAX_URL_ENTRIES + 3; i++) {
      await usePrStatusStore.getState().refreshUrl(`https://github.com/o/r/pull/${i}`, null, true)
    }
    const byUrl = usePrStatusStore.getState().byUrl
    expect(Object.keys(byUrl)).toHaveLength(MAX_URL_ENTRIES)
    expect(byUrl['https://github.com/o/r/pull/0']).toBeUndefined()
  })
})
