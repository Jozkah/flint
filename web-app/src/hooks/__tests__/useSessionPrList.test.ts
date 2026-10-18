import { describe, expect, it, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePrStatusStore, type PrStatus } from '@/stores/pr-status-store'
import { useSessionPrList } from '../useSessionPrList'

const FOLDER = 'C:\\Projects\\acme-weather'

const found = (pr: PrStatus) => ({ lookup: { kind: 'found' as const, pr }, at: Date.now(), loading: false })
const pr = (n: number, over: Partial<PrStatus> = {}): PrStatus => ({
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/acme/weather/pull/${n}`,
  state: 'open',
  head: `b${n}`,
  base: 'main',
  additions: 1,
  deletions: 1,
  checks: { passed: 0, failed: 0, pending: 0 },
  ...over,
})

beforeEach(() => {
  usePrStatusStore.setState({ byFolder: {}, byUrl: {}, sessionPrs: {}, claims: {} })
})

describe('useSessionPrList', () => {
  it('is empty with nothing recorded and no folder pull request', () => {
    const { result } = renderHook(() => useSessionPrList('s1', FOLDER))
    expect(result.current).toEqual({ prs: [], loading: false, error: undefined })
  })

  it('lists the recorded pull requests latest first, with live status where read', () => {
    usePrStatusStore.setState({
      sessionPrs: {
        s1: [
          { url: pr(1).url, number: 1, repo: 'acme/weather', at: '2026-01-01' },
          { url: pr(2).url, number: 2, repo: 'acme/weather', at: '2026-01-02' },
        ],
      },
      byUrl: { [pr(2).url]: found(pr(2, { state: 'merged' })) },
    })
    const { result } = renderHook(() => useSessionPrList('s1', FOLDER))
    expect(result.current.prs.map((p) => p.number)).toEqual([2, 1])
    expect(result.current.prs[0].state).toBe('merged')
    expect(result.current.prs[1].title).toBe('')
  })

  it('puts the folder branch pull request first when it is the session own and not recorded', () => {
    usePrStatusStore.setState({
      byFolder: { [FOLDER]: found(pr(9)) },
      claims: { [`${FOLDER}#9`]: 's1' },
      sessionPrs: { s1: [{ url: pr(1).url, number: 1, repo: 'acme/weather', at: '2026-01-01' }] },
    })
    const { result } = renderHook(() => useSessionPrList('s1', FOLDER))
    expect(result.current.prs.map((p) => p.number)).toEqual([9, 1])
    // Claimed by another session: hidden.
    usePrStatusStore.setState({ claims: { [`${FOLDER}#9`]: 's2' } })
    const again = renderHook(() => useSessionPrList('s1', FOLDER))
    expect(again.result.current.prs.map((p) => p.number)).toEqual([1])
  })

  it('reports a lookup in flight and a failed folder lookup', () => {
    usePrStatusStore.setState({
      sessionPrs: { s1: [{ url: pr(1).url, number: 1, repo: 'acme/weather', at: '2026-01-01' }] },
      byUrl: { [pr(1).url]: { lookup: null, at: 0, loading: true } },
    })
    expect(renderHook(() => useSessionPrList('s1', FOLDER)).result.current.loading).toBe(true)
    usePrStatusStore.setState({
      sessionPrs: {},
      byUrl: {},
      byFolder: { [FOLDER]: { lookup: { kind: 'gh_signed_out' }, at: 1, loading: false } },
    })
    expect(renderHook(() => useSessionPrList('s1', FOLDER)).result.current.error).toBe('gh_signed_out')
  })
})
