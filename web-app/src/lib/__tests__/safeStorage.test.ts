import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeSessionGet, safeSessionRemove, safeSessionSet } from '../safeStorage'
import { attachmentKey, withoutSent } from '../attachmentIntake'

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('safeStorage', () => {
  it('writes through to sessionStorage when it works', () => {
    expect(safeSessionSet('k1', 'v')).toBe(true)
    expect(sessionStorage.getItem('k1')).toBe('v')
    expect(safeSessionGet('k1')).toBe('v')
    safeSessionRemove('k1')
    expect(safeSessionGet('k1')).toBeNull()
  })

  it('keeps the value in memory when the quota is exceeded, and reads it back', () => {
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError')
      })
    expect(safeSessionSet('k2', '{"text":"hi"}')).toBe(false)
    expect(sessionStorage.getItem('k2')).toBeNull()
    expect(safeSessionGet('k2')).toBe('{"text":"hi"}')
    safeSessionRemove('k2')
    expect(safeSessionGet('k2')).toBeNull()
    setItem.mockRestore()
  })

  it('survives storage that throws on read and remove', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(safeSessionGet('nothing')).toBeNull()
    expect(() => safeSessionRemove('nothing')).not.toThrow()
  })
})

describe('withoutSent', () => {
  const a = { type: 'image', name: 'a.png', contentHash: 'h1' }
  const b = { type: 'image', name: 'b.png', contentHash: 'h2' }
  const doc = { type: 'document', name: 'd.pdf', path: '/x/d.pdf' }

  it('drops what was sent and keeps what arrived after', () => {
    expect(withoutSent([a, b, doc], [a, doc])).toEqual([b])
  })

  it('matches a processed copy of the same attachment by id', () => {
    const sent = { ...a, id: 'u1' }
    const stored = { ...a, id: 'u1', processing: false }
    expect(attachmentKey(sent)).toBe(attachmentKey(stored))
    expect(withoutSent([stored, b], [sent])).toEqual([b])
  })

  it('keeps everything when nothing was sent', () => {
    expect(withoutSent([a, b], [])).toEqual([a, b])
  })
})
