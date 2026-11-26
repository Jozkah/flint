import { beforeEach, describe, expect, it, vi } from 'vitest'

const { api, stopAllModels } = vi.hoisted(() => ({
  api: {
    status: vi.fn(async () => ({ supported: true, models: [], engineBackend: 'vulkan', resident: null, upscalers: [] })),
    gallery: vi.fn(async () => []),
    downloadUpscaler: vi.fn(async () => undefined),
    upscale: vi.fn(async () => ({ job_id: 'upscale-1', seed: 1, ids: ['new'], paths: ['p'], duration_ms: 5 })),
  },
  stopAllModels: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }))
vi.mock('@/hooks/useServiceHub', () => ({ getServiceHub: () => ({ models: () => ({ stopAllModels }) }) }))
vi.mock('@/lib/notify', () => ({ allowNotifications: vi.fn(), notifyInBackground: vi.fn() }))
vi.mock('@/lib/studio/studio', () => ({ studioApi: api }))

import { useStudio } from '../useStudio'
import type { GalleryItem, StudioUpscaler } from '@/lib/studio/studio'

const item = { id: 'pic', kind: 'image', path: 'p.png', recipe: { prompt: 'a cat' } } as unknown as GalleryItem
const upscaler: StudioUpscaler = {
  id: 'realesrgan-x4plus',
  displayName: 'Real-ESRGAN x4plus',
  scale: 4,
  license: 'BSD-3-Clause',
  totalBytes: 66_857_836,
  installed: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  useStudio.setState({ job: null, upscalerDownload: null, error: null })
})

describe('upscaling a picture', () => {
  it('downloads a missing upscaler first, then upscales without stopping chat models', async () => {
    const ok = await useStudio.getState().upscale(item, upscaler)
    expect(ok).toBe(true)
    expect(api.downloadUpscaler).toHaveBeenCalledWith('realesrgan-x4plus', undefined)
    expect(api.upscale).toHaveBeenCalledWith('pic', 'realesrgan-x4plus')
    expect(api.downloadUpscaler.mock.invocationCallOrder[0]).toBeLessThan(api.upscale.mock.invocationCallOrder[0])
    expect(stopAllModels).not.toHaveBeenCalled()
    expect(useStudio.getState().upscalerDownload).toBeNull()
  })

  it('skips the download when the upscaler is there', async () => {
    await useStudio.getState().upscale(item, { ...upscaler, installed: true })
    expect(api.downloadUpscaler).not.toHaveBeenCalled()
    expect(api.upscale).toHaveBeenCalledOnce()
  })

  it('does not upscale when the download fails, and says why', async () => {
    api.downloadUpscaler.mockRejectedValueOnce(new Error('offline'))
    const ok = await useStudio.getState().upscale(item, upscaler)
    expect(ok).toBe(false)
    expect(api.upscale).not.toHaveBeenCalled()
    expect(useStudio.getState().error).toBe('offline')
  })

  it('waits for a job already running', async () => {
    useStudio.setState({ job: { kind: 'image', phase: 'sampling', fraction: 0.5, startedAt: 1 } })
    expect(await useStudio.getState().upscale(item, upscaler)).toBe(false)
    expect(api.downloadUpscaler).not.toHaveBeenCalled()
  })
})
