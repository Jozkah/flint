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
  handlers.clear()
  useStudio.setState({
    status: { supported: true, models: [model], engineBackend: 'vulkan', resident: null } as never,
    download: { modelId: 'z-image-turbo', bytes: 0, total: 300 },
  })
  await useStudio.getState().refresh()
})

describe('a model download', () => {
  it('moves the bar from the downloader\'s camelCase progress events', () => {
    handlers.get('huggingface-download-progress')?.({ payload: { taskId: 'diffusion:z-image-turbo:1', downloaded: 40, total: 100 } })
    // The first file is complete, 40 bytes of the second are in.
    expect(useStudio.getState().download).toEqual({ modelId: 'z-image-turbo', bytes: 140, total: 300 })
  })

  it('ignores another download\'s events', () => {
    handlers.get('huggingface-download-progress')?.({ payload: { taskId: 'hf:somebody/else:0', downloaded: 50, total: 100 } })
    expect(useStudio.getState().download?.bytes).toBe(0)
  })
})
