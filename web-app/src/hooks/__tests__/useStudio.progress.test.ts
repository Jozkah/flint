import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { payload: unknown }) => void
const handlers = new Map<string, Handler>()
const { model } = vi.hoisted(() => ({
  model: { id: 'z-image-turbo', totalBytes: 300, files: [{ size: 100 }, { size: 100 }, { size: 100 }] },
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    handlers.set(name, handler)
    return () => undefined
  }),
}))
vi.mock('@/hooks/useServiceHub', () => ({ getServiceHub: () => ({}) }))
vi.mock('@/lib/studio/studio', () => ({
  studioApi: { status: vi.fn(async () => ({ supported: true, models: [model], engineBackend: 'vulkan', resident: null })) },
}))

import { useStudio } from '../useStudio'


beforeEach(async () => {
  // The store registers its listeners once per page load, so keep them across tests.
  useStudio.setState({
    status: { supported: true, models: [model], engineBackend: 'vulkan', resident: null } as never,
    download: { modelId: 'z-image-turbo', bytes: 0, total: 300, fileIndex: 0 },
    downloadFailure: null,
  })
  await useStudio.getState().refresh()
})

describe('a model download', () => {
  it('moves the bar from the downloader\'s camelCase progress events', () => {
    handlers.get('huggingface-download-progress')?.({ payload: { taskId: 'diffusion:z-image-turbo:1', downloaded: 40, total: 100 } })
    // The first file is complete, 40 bytes of the second are in.
    expect(useStudio.getState().download).toEqual({
      modelId: 'z-image-turbo',
      bytes: 140,
      total: 300,
      fileIndex: 1,
      retry: undefined,
    })
  })

  it('ignores another download\'s events', () => {
    handlers.get('huggingface-download-progress')?.({ payload: { taskId: 'hf:somebody/else:0', downloaded: 50, total: 100 } })
    expect(useStudio.getState().download?.bytes).toBe(0)
  })

  it('shows which file is waiting to try again and why', () => {
    handlers.get('huggingface-download-progress')?.({
      payload: { taskId: 'diffusion:z-image-turbo:2', downloaded: 10, retryInMs: 8000, attempt: 3, reason: 'Hugging Face answered 503' },
    })
    const download = useStudio.getState().download
    expect(download?.fileIndex).toBe(2)
    expect(download?.retry).toMatchObject({ attempt: 3, reason: 'Hugging Face answered 503' })
    // A byte arriving again clears the wait.
    handlers.get('huggingface-download-progress')?.({ payload: { taskId: 'diffusion:z-image-turbo:2', downloaded: 20 } })
    expect(useStudio.getState().download?.retry).toBeUndefined()
  })

  it('keeps the files that failed, with their link and destination', () => {
    const files = [{ index: 0, repo: 'o/r', filename: 'a.gguf', size: 100, url: 'https://huggingface.co/o/r/resolve/main/a.gguf', path: 'C:/m/a.gguf', error: 'boom' }]
    handlers.get('diffusion-download-failed')?.({ payload: { modelId: 'z-image-turbo', files } })
    expect(useStudio.getState().downloadFailure).toEqual({ modelId: 'z-image-turbo', files })
  })
})
