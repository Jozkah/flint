import { describe, expect, it, vi } from 'vitest'
import {
  TTL_CHOICES,
  dismissGuestMessage,
  guestLinkUrl,
  nearestTtl,
  sendGuestMessage,
  type GuestPending,
} from '../guestShare'

const pending: GuestPending = {
  shareId: 's1',
  threadId: 't1',
  id: 'p1',
  text: 'hello',
  attachments: [],
  createdMs: 1,
}

describe('guestLinkUrl', () => {
  it('prefers the server url, then the page origin, then the bare path', () => {
    expect(guestLinkUrl({ url: 'https://a.net/g/x', path: '/g/x' }, 'http://o')).toEqual({
      link: 'https://a.net/g/x',
      complete: true,
    })
    expect(guestLinkUrl({ path: '/g/x' }, 'http://o:1340/')).toEqual({
      link: 'http://o:1340/g/x',
      complete: true,
    })
    expect(guestLinkUrl({ path: '/g/x' }, null)).toEqual({ link: '/g/x', complete: false })
  })
})

describe('nearestTtl', () => {
  it('maps the time left onto a listed choice', () => {
    const now = 1_000_000
    expect(nearestTtl(now + 23 * 3_600_000, now)).toBe(24)
    expect(nearestTtl(now + 100 * 3_600_000, now)).toBe(72)
    expect(nearestTtl(now - 5, now)).toBe(TTL_CHOICES[0])
    expect(nearestTtl(now + 500 * 3_600_000, now)).toBe(168)
  })
})

describe('sendGuestMessage', () => {
  it('queues the wrapped text the backend returns, as an ordinary turn', async () => {
    const resolve = vi.fn().mockResolvedValue({ text: 'WRAPPED' })
    const enqueue = vi.fn()
    await sendGuestMessage(pending, { resolve }, enqueue)
    expect(resolve).toHaveBeenCalledWith('s1', 'p1', 'send')
    expect(enqueue).toHaveBeenCalledWith('t1', 'WRAPPED', 'guest-p1')
  })

  it('never queues the raw guest text, or anything when the backend gives none', async () => {
    const enqueue = vi.fn()
    await expect(
      sendGuestMessage(pending, { resolve: vi.fn().mockResolvedValue({}) }, enqueue)
    ).rejects.toThrow()
    await expect(
      sendGuestMessage(pending, { resolve: vi.fn().mockRejectedValue(new Error('gone')) }, enqueue)
    ).rejects.toThrow('gone')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('dismiss only resolves, it queues nothing', async () => {
    const resolve = vi.fn().mockResolvedValue({})
    await dismissGuestMessage(pending, { resolve })
    expect(resolve).toHaveBeenCalledWith('s1', 'p1', 'dismiss')
  })
})
