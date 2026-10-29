import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const live = await import('../live')
const extract = vi.spyOn(live, 'coworkLiveReply')
const { startRemoteEventForwarding } = await import('../events')
const { resetStreams } = await import('../streams')
const { useCoworkRun } = await import('@/hooks/useCoworkRun')
import type { CoworkTurn } from '@/types/coworkSession'

afterEach(() => {
  resetStreams()
  extract.mockClear()
})

// Profile of the phone forwarding path for one streaming Cowork run: how
// many times a token update rebuilds the live reply, and what that costs on
// a long run. Measured before deciding what to change (plan item 34).
describe('live forwarding cost', () => {
  it('rebuilds the live reply at most once per token update', () => {
    const emit = vi.fn()
    const stop = startRemoteEventForwarding(emit)
    try {
      const store = useCoworkRun.getState()
      store.startRun('s1', 'r1')
      const history: CoworkTurn[] = Array.from({ length: 60 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: 'x'.repeat(2000),
      })) as CoworkTurn[]
      extract.mockClear()
      const started = performance.now()
      let text = ''
      for (let i = 0; i < 1000; i++) {
        text += 'tok '
        store.setRunTurns('s1', 'r1', [...history, { role: 'assistant', content: text } as CoworkTurn])
      }
      const ms = performance.now() - started
      // One rebuild per update: the `runs` watcher must not fire for token
      // updates, which only touch `liveTurns`.
      expect(extract.mock.calls.length).toBeLessThanOrEqual(1000)
      // A generous ceiling: this is a regression guard, not a benchmark.
      expect(ms).toBeLessThan(5000)
      console.info(`[profile] 1000 token updates: ${extract.mock.calls.length} rebuilds, ${ms.toFixed(0)} ms`)
    } finally {
      stop()
    }
  })

  it('a token update in one session does not rebuild another session', () => {
    const stop = startRemoteEventForwarding(vi.fn())
    try {
      const store = useCoworkRun.getState()
      store.startRun('a', 'ra')
      store.startRun('b', 'rb')
      extract.mockClear()
      store.setRunTurns('a', 'ra', [{ role: 'assistant', content: 'hi' } as CoworkTurn])
      expect(extract).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })
})
