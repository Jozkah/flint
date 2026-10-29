import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ThreadMessage } from '@janhq/core'

const h = vi.hoisted(() => ({ modify: vi.fn(), del: vi.fn() }))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    messages: () => ({
      createMessage: vi.fn(),
      modifyMessage: h.modify,
      deleteMessage: h.del,
    }),
  }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  i18n: { t: (k: string) => k },
}))

import { useMessages } from '@/hooks/useMessages'
import {
  MESSAGE_PERSIST_DELAY_MS,
  cancelPendingMessageWrites,
  flushPendingMessageWrites,
} from '@/lib/messageWriteQueue'

const msg = (text: string, id = 'm1', thread = 't1') =>
  ({
    id,
    thread_id: thread,
    role: 'assistant',
    content: [{ type: 'text', text: { value: text, annotations: [] } }],
  }) as unknown as ThreadMessage

describe('message write debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    h.modify.mockReset().mockResolvedValue(undefined)
    h.del.mockReset().mockResolvedValue(undefined)
    useMessages.setState({ messages: { t1: [msg('')] } })
  })
  afterEach(async () => {
    await flushPendingMessageWrites()
    vi.useRealTimers()
  })

  it('writes once with the last value after a burst, store updated at once', () => {
    for (let i = 1; i <= 5; i++) useMessages.getState().updateMessage(msg(`v${i}`))
    expect(useMessages.getState().messages.t1[0]).toEqual(msg('v5'))
    expect(h.modify).not.toHaveBeenCalled()
    vi.advanceTimersByTime(MESSAGE_PERSIST_DELAY_MS)
    expect(h.modify).toHaveBeenCalledTimes(1)
    expect(h.modify).toHaveBeenCalledWith(msg('v5'))
  })

  it('flush writes immediately and the timer does not write again', async () => {
    useMessages.getState().updateMessage(msg('a'))
    useMessages.getState().updateMessage(msg('b', 'm2'))
    await flushPendingMessageWrites('t1')
    expect(h.modify).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(MESSAGE_PERSIST_DELAY_MS * 2)
    expect(h.modify).toHaveBeenCalledTimes(2)
  })

  it('flush of one thread leaves other threads pending', async () => {
    useMessages.getState().updateMessage(msg('a'))
    useMessages.getState().updateMessage(msg('x', 'm9', 't2'))
    await flushPendingMessageWrites('t1')
    expect(h.modify).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(MESSAGE_PERSIST_DELAY_MS)
    expect(h.modify).toHaveBeenCalledTimes(2)
  })

  it('deleting the message cancels its pending write', () => {
    useMessages.getState().updateMessage(msg('stale'))
    useMessages.getState().deleteMessage('t1', 'm1')
    vi.advanceTimersByTime(MESSAGE_PERSIST_DELAY_MS * 2)
    expect(h.modify).not.toHaveBeenCalled()
    expect(h.del).toHaveBeenCalledWith('t1', 'm1')
  })

  it('cancelling a thread drops all its pending writes', () => {
    useMessages.getState().updateMessage(msg('a'))
    useMessages.getState().updateMessage(msg('b', 'm2'))
    cancelPendingMessageWrites('t1')
    vi.advanceTimersByTime(MESSAGE_PERSIST_DELAY_MS * 2)
    expect(h.modify).not.toHaveBeenCalled()
  })
})
