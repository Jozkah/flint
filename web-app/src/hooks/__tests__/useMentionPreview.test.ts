import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const src = vi.hoisted(() => ({
  entries: [] as Array<Record<string, unknown>>,
  async: vi.fn(),
  sync: vi.fn(() => [] as unknown[]),
}))
vi.mock('@/lib/chatMentionSources', () => ({
  listConversations: () => src.sync(),
  listConversationsAsync: () => src.async(),
  loadSnapshot: async () => ({ kind: 'room', id: 'r1', title: 'Debate', messages: [] }),
}))

import { useMentionPreview } from '../useMentionPreview'

describe('useMentionPreview', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reads the conversations through the async listing, so rooms are loaded', async () => {
    src.async.mockResolvedValue([{ kind: 'room', id: 'r1', title: 'Debate', updated: 1 }])
    const { result } = renderHook(() => useMentionPreview('see @room:debate'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(src.async).toHaveBeenCalled()
    expect(src.sync).not.toHaveBeenCalled()
    expect(result.current[0]).toMatchObject({ status: 'ok', id: 'r1' })
  })

  it('does not set state after the draft changed', async () => {
    let release!: (v: unknown[]) => void
    src.async.mockImplementation(() => new Promise((r) => (release = r)))
    const { result, rerender } = renderHook(({ p }) => useMentionPreview(p), {
      initialProps: { p: 'see @room:debate' },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    rerender({ p: 'no mention now' })
    await act(async () => {
      release([{ kind: 'room', id: 'r1', title: 'Debate', updated: 1 }])
    })
    expect(result.current).toEqual([])
  })
})
