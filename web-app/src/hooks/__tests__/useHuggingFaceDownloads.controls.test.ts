import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  download: vi.fn(),
  cancelNative: vi.fn(),
  listen: vi.fn(),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => hoisted.listen(...args),
}))
vi.mock('@/lib/huggingface', () => ({
  downloadHuggingFaceFile: (args: unknown) => hoisted.download(args),
  cancelHuggingFaceDownload: (id: string) => hoisted.cancelNative(id),
}))

import {
  cancelHuggingFaceBundle,
  pauseHuggingFaceBundle,
  resumeHuggingFaceBundle,
  startHuggingFaceBundle,
  useHuggingFaceDownloads,
} from '@/hooks/useHuggingFaceDownloads'
import { resetInterruptedDownloadsCache } from '@/lib/interruptedDownloads'

const files = [
  { name: 'a.gguf', size: 100 },
  { name: 'b.gguf', size: 20 },
]

let n = 0
const nextId = () => `hf:controls:${++n}`
const status = (id: string) => useHuggingFaceDownloads.getState().tasks[id]?.status

beforeEach(() => {
  hoisted.download.mockReset()
  hoisted.cancelNative.mockReset().mockResolvedValue(undefined)
  hoisted.listen.mockReset().mockResolvedValue(() => {})
  // Rows left by earlier tests share a repo and files; a new start would join them.
  useHuggingFaceDownloads.setState({ tasks: {}, aliases: {} })
  localStorage.clear()
  resetInterruptedDownloadsCache()
})

describe('pause and cancel', () => {
  it('pause between two files stops before the next file', async () => {
    const id = nextId()
    hoisted.download.mockImplementationOnce(async () => {
      await pauseHuggingFaceBundle(id)
      return '/m/a.gguf'
    })
    await startHuggingFaceBundle({ id, repo: 'o/r', label: 'x', files, onComplete: vi.fn() })
    expect(hoisted.download).toHaveBeenCalledTimes(1)
    expect(status(id)).toBe('paused')
  })

  it('pause while not running is ignored and does not poison the next run', async () => {
    const id = nextId()
    hoisted.download.mockRejectedValueOnce(new Error('boom'))
    await startHuggingFaceBundle({ id, repo: 'o/r', label: 'x', files, onComplete: vi.fn() })
    expect(status(id)).toBe('error')
    await pauseHuggingFaceBundle(id)
    hoisted.download.mockResolvedValue('/m/f.gguf')
    await resumeHuggingFaceBundle(id)
    expect(status(id)).toBe('complete')
  })

  it('cancel between files ends cancelled and skips the next file', async () => {
    const id = nextId()
    hoisted.download.mockImplementationOnce(async () => {
      await cancelHuggingFaceBundle(id)
      return '/m/a.gguf'
    })
    await startHuggingFaceBundle({ id, repo: 'o/r', label: 'x', files, onComplete: vi.fn() })
    expect(hoisted.download).toHaveBeenCalledTimes(1)
    expect(status(id)).toBe('cancelled')
  })

  it('cancel during importing is ignored; status ends complete', async () => {
    const id = nextId()
    hoisted.download.mockResolvedValue('/m/f.gguf')
    await startHuggingFaceBundle({
      id,
      repo: 'o/r',
      label: 'x',
      files,
      onComplete: async () => {
        expect(status(id)).toBe('importing')
        await cancelHuggingFaceBundle(id)
      },
    })
    expect(status(id)).toBe('complete')
  })

  it('cancelling a paused download marks it cancelled and drops the runner', async () => {
    const id = nextId()
    hoisted.download.mockRejectedValueOnce(new Error('Download paused'))
    await startHuggingFaceBundle({ id, repo: 'o/r', label: 'x', files, onComplete: vi.fn() })
    expect(status(id)).toBe('paused')
    await cancelHuggingFaceBundle(id)
    expect(status(id)).toBe('cancelled')
    await expect(resumeHuggingFaceBundle(id)).rejects.toThrow()
  })
})

describe('runner lifetime', () => {
  it('is dropped after complete, kept after paused and error, dropped by remove', async () => {
    const done = nextId()
    hoisted.download.mockResolvedValue('/m/f.gguf')
    await startHuggingFaceBundle({ id: done, repo: 'o/r', label: 'x', files, token: 't' })
    expect(status(done)).toBe('complete')
    await expect(resumeHuggingFaceBundle(done)).rejects.toThrow()

    const paused = nextId()
    hoisted.download.mockReset().mockRejectedValueOnce(new Error('Download paused'))
    await startHuggingFaceBundle({ id: paused, repo: 'o/r', label: 'x', files })
    hoisted.download.mockResolvedValue('/m/f.gguf')
    await resumeHuggingFaceBundle(paused)
    expect(status(paused)).toBe('complete')

    const failed = nextId()
    hoisted.download.mockReset().mockRejectedValueOnce(new Error('boom'))
    await startHuggingFaceBundle({ id: failed, repo: 'o/r', label: 'x', files })
    expect(status(failed)).toBe('error')
    useHuggingFaceDownloads.getState().remove(failed)
    await expect(resumeHuggingFaceBundle(failed)).rejects.toThrow()
  })

  it('a rejected listen is retried on the next run', async () => {
    hoisted.listen.mockReset().mockRejectedValueOnce(new Error('no ipc')).mockResolvedValue(() => {})
    hoisted.download.mockResolvedValue('/m/f.gguf')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The listener is cached per module, so use a fresh copy of it.
    vi.resetModules()
    const fresh = await import('@/hooks/useHuggingFaceDownloads')
    await fresh.startHuggingFaceBundle({ id: nextId(), repo: 'o/r', label: 'x', files })
    await fresh.startHuggingFaceBundle({ id: nextId(), repo: 'o/r', label: 'x', files })
    expect(hoisted.listen).toHaveBeenCalledTimes(2)
  })
})
