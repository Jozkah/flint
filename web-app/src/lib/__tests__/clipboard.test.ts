import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyToClipboard, copyViaExecCommand } from '@/lib/clipboard'

const setClipboard = (value: unknown) =>
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })

const setExec = (impl: unknown) =>
  Object.defineProperty(document, 'execCommand', {
    value: impl,
    configurable: true,
    writable: true,
  })

afterEach(() => {
  setClipboard(undefined)
  setExec(undefined)
})

describe('copyToClipboard', () => {
  it('is true once the write has finished', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    await expect(copyToClipboard('secret')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('secret')
  })

  it('is false when the write is refused and the fallback fails too', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    setExec(vi.fn().mockReturnValue(false))
    await expect(copyToClipboard('x')).resolves.toBe(false)
  })

  it('is false when there is no clipboard and no fallback', async () => {
    setClipboard(undefined)
    await expect(copyToClipboard('x')).resolves.toBe(false)
  })

  it('falls back to execCommand when the async API is missing', async () => {
    setClipboard(undefined)
    let copied = ''
    setExec(
      vi.fn(() => {
        copied = (document.querySelector('textarea') as HTMLTextAreaElement).value
        return true
      })
    )
    await expect(copyToClipboard('from fallback')).resolves.toBe(true)
    expect(copied).toBe('from fallback')
    expect(document.execCommand).toHaveBeenCalledWith('copy')
  })

  it('falls back to execCommand when the async write is refused', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    setExec(vi.fn().mockReturnValue(true))
    await expect(copyToClipboard('x')).resolves.toBe(true)
  })
})

describe('copyViaExecCommand', () => {
  it('removes its textarea and survives a throwing execCommand', () => {
    setExec(
      vi.fn(() => {
        throw new Error('nope')
      })
    )
    expect(copyViaExecCommand('x')).toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })
})
