import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('engine activity persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    vi.resetModules()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes once after a burst of tool calls, not on each call', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem')
    const { recordToolCall } = await import('../engine-activity-store')
    for (let i = 0; i < 20; i++) recordToolCall({ server: 's', tool: 't', ok: true })
    expect(spy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1500)
    expect(spy).toHaveBeenCalledTimes(1)
    const saved = JSON.parse(localStorage.getItem('flint-engine-activity') ?? '{}')
    expect(saved.state.toolCalls).toHaveLength(20)
    spy.mockRestore()
  })
})
