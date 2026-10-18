import { describe, it, expect, vi } from 'vitest'
import { followSentMessage } from '../followSentMessage'

describe('followSentMessage', () => {
  it('scrolls to the bottom now and again once the message is laid out', async () => {
    vi.useFakeTimers()
    const scrollToBottom = vi.fn(() => true)
    followSentMessage({ scrollToBottom })
    expect(scrollToBottom).toHaveBeenCalledTimes(1)
    await vi.runAllTimersAsync()
    expect(scrollToBottom).toHaveBeenCalledTimes(2)
    expect(scrollToBottom).toHaveBeenLastCalledWith('instant')
    vi.useRealTimers()
  })

  it('does nothing before the transcript is mounted', () => {
    expect(() => followSentMessage(null)).not.toThrow()
  })
})
