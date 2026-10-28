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
  pauseHuggingFaceBundle,
  resolveBundleId,
  startHuggingFaceBundle,
  useHuggingFaceDownloads,
} from '@/hooks/useHuggingFaceDownloads'
import { resetInterruptedDownloadsCache } from '@/lib/interruptedDownloads'

const files = [{ name: 'model-Q4_K_M.gguf', size: 100 }]

let n = 0
const nextId = () => `hf:dedup:${++n}`
const state = () => useHuggingFaceDownloads.getState()

type Progress = { payload: { taskId: string; downloaded: number; total?: number; retryInMs?: number; attempt?: number } }
let onProgress: ((event: Progress) => void) | undefined

beforeEach(() => {
  hoisted.download.mockReset()
  hoisted.cancelNative.mockReset().mockResolvedValue(undefined)
  hoisted.listen.mockReset().mockImplementation(async (_name: string, handler: (event: Progress) => void) => {
    onProgress = handler
    return () => {}
  })
  localStorage.clear()
  resetInterruptedDownloadsCache()
})

/** A native download that stays open until `release` is called. */
function holdDownload() {
  let release: (path: string) => void = () => {}
  hoisted.download.mockImplementationOnce(
    () => new Promise<string>((resolve) => (release = resolve))
  )
  return (path: string) => release(path)
}

describe('a second start for the same files', () => {
  it('joins the running download instead of making a second row', async () => {
    const first = nextId()
    const second = nextId()
    const release = holdDownload()
    const running = startHuggingFaceBundle({ id: first, repo: 'o/r', label: 'a', files, revision: 'main' })
    await vi.waitFor(() => expect(hoisted.download).toHaveBeenCalledTimes(1))

    await startHuggingFaceBundle({ id: second, repo: 'o/r', label: 'b', files, revision: 'main' })
    expect(state().tasks[second]).toBeUndefined()
    expect(resolveBundleId(state(), second)).toBe(first)
    expect(hoisted.download).toHaveBeenCalledTimes(1)

    release('/m/model.gguf')
    await running
    expect(state().tasks[first]?.status).toBe('complete')
  })

  it('resumes a paused download that holds the same files', async () => {
    const first = nextId()
    const second = nextId()
    hoisted.download.mockImplementationOnce(async () => {
      await pauseHuggingFaceBundle(first)
      throw new Error('Download paused')
    })
    await startHuggingFaceBundle({ id: first, repo: 'o/r', label: 'a', files })
    expect(state().tasks[first]?.status).toBe('paused')

    hoisted.download.mockResolvedValueOnce('/m/model.gguf')
    await startHuggingFaceBundle({ id: second, repo: 'o/r', label: 'b', files })
    expect(state().tasks[second]).toBeUndefined()
    expect(state().tasks[first]?.status).toBe('complete')
  })

  it('starts its own row for another revision or other files', async () => {
    const first = nextId()
    const release = holdDownload()
    const running = startHuggingFaceBundle({ id: first, repo: 'o/r2', label: 'a', files, revision: 'v1' })
    await vi.waitFor(() => expect(hoisted.download).toHaveBeenCalledTimes(1))

    const otherRevision = nextId()
    hoisted.download.mockResolvedValueOnce('/m/x.gguf')
    await startHuggingFaceBundle({ id: otherRevision, repo: 'o/r2', label: 'b', files, revision: 'v2' })
    expect(state().tasks[otherRevision]?.status).toBe('complete')

    const otherFiles = nextId()
    hoisted.download.mockResolvedValueOnce('/m/y.gguf')
    await startHuggingFaceBundle({
      id: otherFiles,
      repo: 'o/r2',
      label: 'c',
      files: [{ name: 'model-Q8_0.gguf', size: 100 }],
      revision: 'v1',
    })
    expect(state().tasks[otherFiles]?.status).toBe('complete')

    release('/m/model.gguf')
    await running
  })
})

describe('retry state from progress events', () => {
  it('sets a retry deadline while waiting and clears it when bytes flow again', async () => {
    const id = nextId()
    const release = holdDownload()
    const running = startHuggingFaceBundle({ id, repo: 'o/r3', label: 'a', files })
    await vi.waitFor(() => expect(hoisted.download).toHaveBeenCalledTimes(1))
    const taskId = state().tasks[id]!.currentTaskId!

    const before = Date.now()
    onProgress?.({ payload: { taskId, downloaded: 10, total: 100, retryInMs: 64_000, attempt: 6 } })
    const waiting = state().tasks[id]!
    expect(waiting.retryAttempt).toBe(6)
    expect(waiting.retryAt).toBeGreaterThanOrEqual(before + 64_000)

    onProgress?.({ payload: { taskId, downloaded: 20, total: 100 } })
    expect(state().tasks[id]!.retryAt).toBeUndefined()

    release('/m/model.gguf')
    await running
  })
})
