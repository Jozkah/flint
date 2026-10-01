import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyToClipboard } from '@/lib/clipboard'

const setClipboard = (value: unknown) =>
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })

afterEach(() => setClipboard(undefined))

describe('copyToClipboard', () => {
  it('is true once the write has finished', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    await expect(copyToClipboard('secret')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('secret')
  })

  it('is false when the write is refused', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    await expect(copyToClipboard('x')).resolves.toBe(false)
  })

  it('is false when there is no clipboard', async () => {
    setClipboard(undefined)
    await expect(copyToClipboard('x')).resolves.toBe(false)
  })
})
