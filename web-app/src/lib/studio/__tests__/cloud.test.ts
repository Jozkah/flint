import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/studio/studio', () => ({
  studioApi: {
    saveExternalImages: vi.fn(async (p: { images: string[] }) => ({
      job_id: 'cloud_1',
      seed: 0,
      ids: p.images.map((_, i) => `id${i}`),
      paths: [],
      duration_ms: 1,
    })),
  },
}))
vi.mock('@/lib/providerFetch', () => ({ providerFetch: vi.fn() }))

import {
  CLOUD_IMAGE_PROVIDERS,
  buildCloudBody,
  bytesToBase64,
  cloudKey,
  cloudTargets,
  describeCloudFailure,
  fitCloudSize,
  generateCloudImages,
  imagesUrl,
  isPublicHttpsUrl,
  nearestAspectRatio,
  readCloudAnswer,
  targetFor,
} from '../cloud'
import { studioApi } from '@/lib/studio/studio'

const by = (id: string) => CLOUD_IMAGE_PROVIDERS.find((p) => p.provider === id)!

describe('cloud targets', () => {
  it('offers only the providers that are set up, as provider/model keys', () => {
    expect(cloudTargets(new Set()).length).toBe(0)
    const keys = cloudTargets(new Set(['openai'])).map((t) => t.key)
    expect(keys).toEqual(['openai/gpt-image-2.5-flare', 'openai/gpt-image-2.5-sunburst'])
    expect(targetFor(cloudKey('xai', 'grok-imagine-image-2.0'), new Set(['xai']))?.provider.label).toBe('xAI')
    expect(targetFor('openai/gpt-image-2.5-flare', new Set(['xai']))).toBeUndefined()
  })
})

describe('fitCloudSize', () => {
  it('leaves a size the provider takes alone, in multiples of 16', () => {
    expect(fitCloudSize(by('openai'), 1024, 1024)).toEqual({ width: 1024, height: 1024 })
    expect(fitCloudSize(by('openai'), 1360, 768)).toEqual({ width: 1360, height: 768 })
  })

  it('shrinks to the longest side a provider allows, keeping the shape', () => {
    const fit = fitCloudSize(by('together'), 2048, 1024)
    expect(Math.max(fit.width, fit.height)).toBeLessThanOrEqual(1440)
    expect(fit.width / fit.height).toBeCloseTo(2, 1)
  })

  it('grows a size that is below the area a provider needs', () => {
    const fit = fitCloudSize(by('openai'), 512, 512)
    expect(fit.width * fit.height).toBeGreaterThanOrEqual(640_000)
    expect(fit.width).toBe(fit.height)
  })
})

describe('buildCloudBody', () => {
  const model = { id: 'm', name: 'M' }
  const params = { prompt: 'a fox', width: 1024, height: 1024, count: 2 }

  it('sends pixels as WxH to the providers that take them, without a response format for OpenAI', () => {
    const body = buildCloudBody(by('openai'), model, params)
    expect(body).toEqual({ model: 'm', prompt: 'a fox', n: 2, size: '1024x1024' })
    expect(buildCloudBody(by('gemini'), model, params)).toMatchObject({ size: '1024x1024', response_format: 'b64_json' })
  })

  it('sends width and height for Together and a shape for xAI', () => {
    expect(buildCloudBody(by('together'), model, params)).toMatchObject({
      width: 1024,
      height: 1024,
      response_format: 'base64',
    })
    expect(buildCloudBody(by('xai'), model, { ...params, width: 1360, height: 768 })).toMatchObject({
      aspect_ratio: '16:9',
      response_format: 'b64_json',
    })
  })

  it('keeps the number of pictures between one and the provider maximum', () => {
    expect(buildCloudBody(by('openai'), model, { ...params, count: 0 }).n).toBe(1)
    expect(buildCloudBody(by('openai'), model, { ...params, count: 99 }).n).toBe(4)
  })
})

describe('nearestAspectRatio', () => {
  it('names the closest standard shape', () => {
    expect(nearestAspectRatio(1024, 1024)).toBe('1:1')
    expect(nearestAspectRatio(768, 1360)).toBe('9:16')
    expect(nearestAspectRatio(1000, 760)).toBe('4:3')
  })
})

describe('imagesUrl', () => {
  it('adds the path once', () => {
    expect(imagesUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/images/generations')
    expect(imagesUrl('https://api.x.ai/v1/')).toBe('https://api.x.ai/v1/images/generations')
    expect(imagesUrl('  ')).toBeNull()
    expect(imagesUrl(undefined)).toBeNull()
  })
})

describe('readCloudAnswer', () => {
  it('reads base64 and https pictures and drops what is neither', () => {
    const answer = readCloudAnswer({
      data: [{ b64_json: 'AAA' }, { url: 'https://cdn.example/x.png' }, { url: 'http://insecure/x.png' }, {}, null],
    })
    expect(answer.pictures).toEqual([
      { b64: 'AAA', url: undefined },
      { b64: undefined, url: 'https://cdn.example/x.png' },
    ])
  })

  it('carries the provider message from either error shape', () => {
    expect(readCloudAnswer({ error: { message: 'bad size' } }).error).toBe('bad size')
    expect(readCloudAnswer({ error: 'quota' }).error).toBe('quota')
    expect(readCloudAnswer(undefined).pictures).toEqual([])
  })
})

describe('describeCloudFailure', () => {
  it('says what to do for the common refusals', () => {
    expect(describeCloudFailure(401, 'OpenAI')).toContain('API key')
    expect(describeCloudFailure(429, 'xAI')).toContain('limiting')
    expect(describeCloudFailure(503, 'Gemini')).toContain('problem on its side')
    expect(describeCloudFailure(400, 'Together AI', 'size not allowed')).toContain('size not allowed')
  })
})

describe('bytesToBase64', () => {
  it('encodes small and large buffers', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=')
    expect(bytesToBase64(new Uint8Array(100_000)).length).toBeGreaterThan(100_000)
  })
})

describe('generateCloudImages', () => {
  const target = cloudTargets(new Set(['openai']))[0]
  const settings = { base_url: 'https://api.openai.com/v1', api_key: 'sk-test' }
  const params = { prompt: 'a fox', width: 1024, height: 1024, count: 1 }
  const reply = (status: number, body: unknown): Response =>
    ({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(body),
      arrayBuffer: async () => new ArrayBuffer(3),
    }) as unknown as Response

  it('posts with the key, keeps base64 pictures and reports them', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { data: [{ b64_json: 'AAAA' }] }))
    const out = await generateCloudImages(target, settings, params, new AbortController().signal, fetchImpl as never)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/images/generations')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'gpt-image-2.5-flare', size: '1024x1024' })
    expect(studioApi.saveExternalImages).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'openai/gpt-image-2.5-flare',
        modelName: 'GPT Image 2.5 Flare · OpenAI',
        images: ['AAAA'],
      })
    )
    expect(out.ids).toEqual(['id0'])
  })

  it('downloads a picture that came as a URL', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { data: [{ url: 'https://cdn.example/x.png' }] }))
      .mockResolvedValueOnce(reply(200, {}))
    await generateCloudImages(target, settings, params, new AbortController().signal, fetchImpl as never)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(studioApi.saveExternalImages).toHaveBeenLastCalledWith(
      expect.objectContaining({ images: [expect.any(String)] })
    )
  })

  it('refuses without a key or an endpoint, and shows the provider reason on a failure', async () => {
    const signal = new AbortController().signal
    await expect(generateCloudImages(target, { base_url: settings.base_url }, params, signal)).rejects.toThrow('API key')
    await expect(generateCloudImages(target, { api_key: 'k' }, params, signal)).rejects.toThrow('endpoint')
    const refused = vi.fn(async () => reply(400, { error: { message: 'size not allowed' } }))
    await expect(generateCloudImages(target, settings, params, signal, refused as never)).rejects.toThrow(
      'size not allowed'
    )
  })
})

describe('isPublicHttpsUrl', () => {
  it('accepts a public https address', () => {
    expect(isPublicHttpsUrl('https://cdn.example.com/x.png')).toBe(true)
    expect(isPublicHttpsUrl('https://8.8.8.8/x.png')).toBe(true)
  })

  it('refuses http, this computer, private networks and credentials in the address', () => {
    for (const url of [
      'http://cdn.example.com/x.png',
      'https://localhost/x.png',
      'https://app.localhost/x.png',
      'https://127.0.0.1/x.png',
      'https://10.1.2.3/x.png',
      'https://172.20.0.1/x.png',
      'https://192.168.1.5/x.png',
      'https://169.254.169.254/latest',
      'https://100.64.0.1/x.png',
      'https://[::1]/x.png',
      'https://[fd00::1]/x.png',
      'https://printer.local/x.png',
      'https://intranet/x.png',
      'https://user:pw@cdn.example.com/x.png',
      'file:///C:/x.png',
      'not a url',
    ]) {
      expect(isPublicHttpsUrl(url), url).toBe(false)
    }
  })

  it('drops such an address from a provider answer', () => {
    expect(readCloudAnswer({ data: [{ url: 'https://127.0.0.1/x.png' }] }).pictures).toEqual([])
  })
})
