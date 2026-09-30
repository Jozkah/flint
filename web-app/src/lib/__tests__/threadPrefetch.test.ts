import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadMessage } from '@janhq/core'
import { useMessages } from '@/hooks/useMessages'
import { loadThreadMessages, prefetchThreadMessages } from '../threadPrefetch'

const msgs = [{ id: 'm1' }] as unknown as ThreadMessage[]

beforeEach(() => {
  useMessages.setState({ messages: {} })
})

describe('thread prefetch', () => {
  it('reads once on hover and hands that read to the open', async () => {
    const fetch = vi.fn().mockResolvedValue(msgs)
    prefetchThreadMessages('t-hover', fetch)
    prefetchThreadMessages('t-hover', fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await loadThreadMessages('t-hover', fetch)).toBe(msgs)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reads fresh when nothing was prefetched', async () => {
    const fetch = vi.fn().mockResolvedValue(msgs)
    expect(await loadThreadMessages('t-cold', fetch)).toBe(msgs)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not prefetch a chat whose messages are already here, or the temporary chat', () => {
    const fetch = vi.fn().mockResolvedValue(msgs)
    useMessages.setState({ messages: { 't-loaded': msgs } })
    prefetchThreadMessages('t-loaded', fetch)
    prefetchThreadMessages('temporary-chat', fetch)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('falls back to a fresh read when the prefetch failed', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk'))
      .mockResolvedValueOnce(msgs)
    prefetchThreadMessages('t-fail', fetch)
    expect(await loadThreadMessages('t-fail', fetch)).toBe(msgs)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
