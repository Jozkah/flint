import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => h.invoke(...a),
}))

import { usePrStatusStore, claimKey } from '@/stores/pr-status-store'

const found = {
  kind: 'found',
  pr: {
    number: 12,
    title: 'Fix',
    url: 'https://github.com/o/r/pull/12',
    state: 'open',
    head: 'fix/x',
    base: 'main',
    additions: 1,
    deletions: 1,
    checks: { passed: 0, failed: 0, pending: 0 },
  },
}

const FOLDER = 'repo-claimant'

describe('pr status claimant', () => {
  beforeEach(() => {
    h.invoke.mockReset()
    usePrStatusStore.setState({ byFolder: {}, claims: {} })
  })

  it('a call that returns early on a fresh answer leaves no claimant behind', async () => {
    usePrStatusStore.setState({
      byFolder: {
        [FOLDER]: {
          lookup: { kind: 'no_pull_request' },
          at: Date.now(),
          loading: false,
        },
      },
    })
    await usePrStatusStore.getState().refresh(FOLDER, false, 'sessA')
    expect(h.invoke).not.toHaveBeenCalled()

    h.invoke.mockResolvedValue(found)
    await usePrStatusStore.getState().refresh(FOLDER, true)
    expect(usePrStatusStore.getState().claims).toEqual({})
  })

  it('claims for the session whose call started the lookup', async () => {
    h.invoke.mockResolvedValue(found)
    await usePrStatusStore.getState().refresh(FOLDER, true, 'sessA')
    expect(usePrStatusStore.getState().claims).toEqual({
      [claimKey(FOLDER, 12)]: 'sessA',
    })
  })

  it('an overlapping refresh does not hand its claimant to the running lookup', async () => {
    let first!: (v: unknown) => void
    h.invoke.mockImplementationOnce(() => new Promise((r) => (first = r)))
    const running = usePrStatusStore.getState().refresh(FOLDER, true)
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1))

    h.invoke.mockResolvedValue({ kind: 'no_pull_request' })
    void usePrStatusStore.getState().refresh(FOLDER, false, 'sessB')
    first(found)
    await running
    expect(usePrStatusStore.getState().claims).toEqual({})
  })
})
