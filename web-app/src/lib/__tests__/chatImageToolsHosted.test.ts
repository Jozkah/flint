import { describe, it, expect, vi, beforeEach } from 'vitest'

const status = vi.fn()
const generateImage = vi.fn()
const media = vi.fn()
const cloudGenerate = vi.fn()

vi.mock('@/lib/studio/studio', () => ({
  studioApi: {
    status: () => status(),
    generateImage: (p: unknown) => generateImage(p),
    media: (k: string, id: string) => media(k, id),
  },
}))
vi.mock('@/lib/studio/cloud', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/studio/cloud')>()
  return {
    ...real,
    generateCloudImages: (...args: unknown[]) => cloudGenerate(...args),
  }
})

import { runImageTool } from '../chatImageTools'
import { addChatImages, findChatImage } from '../chatImages'
import { useModelProvider } from '@/hooks/useModelProvider'
import { writeLastHostedImageModel } from '../studio/lastHostedImage'

const none = { supported: true, resident: null }
const loaded = { supported: true, resident: { model_id: 'z-image-turbo', kind: 'image', busy: false } }

const requesty = (models: Array<{ id: string; capabilities: string[] }>) => ({
  active: true,
  provider: 'requesty',
  displayName: 'Requesty',
  base_url: 'https://router.requesty.ai/v1',
  api_key: 'rq-key',
  models,
})
const GPT_IMAGE = { id: 'azure/openai/gpt-image-1', capabilities: ['image_generation'] }
const OTHER_IMAGE = { id: 'vendor/drawer', capabilities: ['image_generation'] }

const setProviders = (providers: unknown[]) =>
  useModelProvider.setState({ providers: providers as ModelProvider[] })

let n = 0
const thread = () => `th-${++n}`
const text = (r: { content?: string }) => JSON.parse(r.content ?? '{}')

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  status.mockResolvedValue(none)
  media.mockImplementation(async (_k: string, id: string) => `data:image/png;base64,${id}`)
  cloudGenerate.mockResolvedValue({ ids: ['g1'], seed: 0, paths: [], job_id: 'j', duration_ms: 1 })
  setProviders([])
})

describe('image_gen with no local picture model', () => {
  it('keeps the old error when no hosted model is set up either', async () => {
    const r = await runImageTool('image_gen', { prompt: 'a cat' }, thread())
    expect(r.error).toMatch(/No image model is loaded/)
    expect(cloudGenerate).not.toHaveBeenCalled()
  })

  it('uses the only hosted picture model and names the picture like a local one', async () => {
    setProviders([requesty([GPT_IMAGE])])
    const t = thread()
    const r = await runImageTool('image_gen', { prompt: 'a cat', count: 2 }, t)
    expect(r.error).toBeUndefined()
    expect(text(r)).toMatchObject({ status: 'done', model: 'requesty/azure/openai/gpt-image-1', images: ['img_1'] })
    expect(r.images?.[0].name).toBe('img_1.png')
    expect(findChatImage(t, 'img_1')?.galleryId).toBe('g1')
    const [target, settings, params] = cloudGenerate.mock.calls[0]
    expect(target.key).toBe('requesty/azure/openai/gpt-image-1')
    expect(settings.api_key).toBe('rq-key')
    expect(params).toMatchObject({ prompt: 'a cat', count: 2, width: 1024, height: 1024 })
    expect(params.sourceImages).toBeUndefined()
  })

  it('prefers the model last used in Studio when several are offered', async () => {
    setProviders([requesty([GPT_IMAGE, OTHER_IMAGE])])
    writeLastHostedImageModel('requesty/vendor/drawer')
    await runImageTool('image_gen', { prompt: 'a cat' }, thread())
    expect(cloudGenerate.mock.calls[0][0].key).toBe('requesty/vendor/drawer')
  })

  it('lists the choices when several are offered and none was chosen', async () => {
    setProviders([requesty([GPT_IMAGE, OTHER_IMAGE])])
    const r = await runImageTool('image_gen', { prompt: 'a cat' }, thread())
    expect(r.error).toContain('requesty/azure/openai/gpt-image-1')
    expect(r.error).toContain('requesty/vendor/drawer')
    expect(cloudGenerate).not.toHaveBeenCalled()
  })

  it('rejects a bad count before any request', async () => {
    setProviders([requesty([GPT_IMAGE])])
    const r = await runImageTool('image_gen', { prompt: 'a cat', count: 9 }, thread())
    expect(r.error).toMatch(/count must be/)
    expect(cloudGenerate).not.toHaveBeenCalled()
  })

  it('reports a provider failure as the tool error', async () => {
    setProviders([requesty([GPT_IMAGE])])
    cloudGenerate.mockRejectedValue(new Error('Requesty did not accept the API key. Check it in Providers.'))
    const r = await runImageTool('image_gen', { prompt: 'a cat' }, thread())
    expect(r.error).toMatch(/did not accept the API key/)
  })

  it('says it gave up waiting when the hosted model takes too long', async () => {
    vi.useFakeTimers()
    try {
      setProviders([requesty([GPT_IMAGE])])
      cloudGenerate.mockImplementation(
        (_t: unknown, _s: unknown, _p: unknown, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('The request was aborted.')))
          })
      )
      const pending = runImageTool('image_gen', { prompt: 'a cat' }, thread())
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
      const r = await pending
      expect(r.error).toMatch(/Requesty did not return a picture within 5 minutes/)
      expect(r.error).not.toMatch(/was aborted/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still prefers the local picture model when one is loaded', async () => {
    status.mockResolvedValue(loaded)
    setProviders([requesty([GPT_IMAGE])])
    generateImage.mockResolvedValue({ ids: ['loc1'], seed: 7, paths: [], job_id: 'j', duration_ms: 1 })
    const r = await runImageTool('image_gen', { prompt: 'a cat' }, thread())
    expect(text(r).model).toBe('z-image-turbo')
    expect(cloudGenerate).not.toHaveBeenCalled()
  })
})

describe('image_edit with no local picture model', () => {
  it('edits through a hosted model that takes edits, sending the picture as a data URL', async () => {
    setProviders([requesty([GPT_IMAGE])])
    const t = thread()
    addChatImages(t, [{ galleryId: 'src1', prompt: 'p' }])
    const r = await runImageTool('image_edit', { prompt: 'sunset', image: 'img_1' }, t)
    expect(r.error).toBeUndefined()
    expect(cloudGenerate.mock.calls[0][2].sourceImages).toEqual(['data:image/png;base64,src1'])
    expect(text(r).images).toEqual(['img_2'])
  })

  it('says hosted editing is not supported when the hosted models cannot edit', async () => {
    setProviders([
      {
        active: true,
        provider: 'gateway',
        base_url: 'https://gw.example.com/v1',
        api_key: 'k',
        models: [GPT_IMAGE],
      },
    ])
    const t = thread()
    addChatImages(t, [{ galleryId: 'src1', prompt: 'p' }])
    const r = await runImageTool('image_edit', { prompt: 'sunset', image: 'img_1' }, t)
    expect(r.error).toMatch(/cannot edit pictures yet/)
    expect(cloudGenerate).not.toHaveBeenCalled()
  })

  it('keeps the old error with no hosted model at all', async () => {
    const t = thread()
    addChatImages(t, [{ galleryId: 'src1', prompt: 'p' }])
    const r = await runImageTool('image_edit', { prompt: 'sunset', image: 'img_1' }, t)
    expect(r.error).toMatch(/No image model is loaded/)
  })
})
