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
  buildCloudBody,
  buildCloudEditBody,
  customCloudTargets,
  editsUrl,
  fitCloudSize,
  generateCloudImages,
  hostedImageTargets,
  isPictureModel,
  nearestFixedSize,
  pickHostedTarget,
  type CloudTarget,
} from '../cloud'

const requesty = {
  active: true,
  provider: 'requesty',
  displayName: 'Requesty',
  base_url: 'https://router.requesty.ai/v1',
  api_key: 'rq-key',
  models: [
    { id: 'openai/gpt-4o-mini', capabilities: ['completion', 'tools'] },
    { id: 'azure/openai/gpt-image-1', capabilities: ['image_generation'] },
    { id: 'vendor/drawer', capabilities: ['image_generation'] },
    { id: 'vendor/embedder', embedding: true, capabilities: ['embeddings'] },
  ],
}

describe('isPictureModel', () => {
  it('trusts the image_generation tag, whatever the name', () => {
    expect(isPictureModel({ id: 'vendor/drawer', capabilities: ['image_generation'] })).toBe(true)
  })
  it('falls back to the name', () => {
    expect(isPictureModel({ id: 'qwen-image-2.1' })).toBe(true)
    expect(isPictureModel({ id: 'openai/gpt-4o-mini', capabilities: ['completion'] })).toBe(false)
  })
})

describe('Requesty picture targets', () => {
  it('offers every model tagged for pictures, with no name guessing', () => {
    const targets = customCloudTargets([requesty])
    expect(targets.map((t) => t.key)).toEqual([
      'requesty/azure/openai/gpt-image-1',
      'requesty/vendor/drawer',
    ])
  })

  it('needs a key, asks for the three fixed shapes and takes JSON edits', () => {
    const { provider } = customCloudTargets([requesty])[0]
    expect(provider.keyless).toBe(false)
    expect(provider.jsonEdits).toBe(true)
    expect(provider.sizes).toEqual([
      [1024, 1024],
      [1536, 1024],
      [1024, 1536],
    ])
  })

  it('leaves the answer format to Requesty and snaps the size to a shape it takes', () => {
    const target = customCloudTargets([requesty])[0]
    const body = buildCloudBody(target.provider, target.model, {
      prompt: 'a cat',
      width: 1344,
      height: 768,
      count: 2,
    })
    expect(body).toMatchObject({ model: 'azure/openai/gpt-image-1', n: 2, size: '1536x1024' })
    expect(body).not.toHaveProperty('response_format')
  })

  it('recognises Requesty by its address when the provider id differs', () => {
    const renamed = { ...requesty, provider: 'my-router', base_url: 'https://router.eu.requesty.ai/v1' }
    expect(customCloudTargets([renamed])[0].provider.jsonEdits).toBe(true)
  })

  it('keeps other gateways in the plain shape', () => {
    const other = { ...requesty, provider: 'gateway', base_url: 'https://gw.example.com/v1' }
    const { provider } = customCloudTargets([other])[0]
    expect(provider.jsonEdits).toBeUndefined()
    expect(provider.format).toEqual({ response_format: 'b64_json' })
  })
})

describe('fixed picture sizes', () => {
  const sizes: Array<[number, number]> = [
    [1024, 1024],
    [1536, 1024],
    [1024, 1536],
  ]
  it('picks the shape nearest the one asked for', () => {
    expect(nearestFixedSize(sizes, 1024, 1024)).toEqual({ width: 1024, height: 1024 })
    expect(nearestFixedSize(sizes, 1920, 1080)).toEqual({ width: 1536, height: 1024 })
    expect(nearestFixedSize(sizes, 720, 1280)).toEqual({ width: 1024, height: 1536 })
  })
  it('takes the earlier shape on a tie and survives a zero side', () => {
    expect(nearestFixedSize(sizes, 0, 0)).toEqual({ width: 1024, height: 1024 })
  })
  it('is what fitCloudSize returns for a provider with fixed sizes', () => {
    const { provider } = customCloudTargets([requesty])[0]
    expect(fitCloudSize(provider, 4000, 1000)).toEqual({ width: 1536, height: 1024 })
  })
})

describe('hostedImageTargets', () => {
  it('joins built-in providers with a key and gateway picture models', () => {
    const openai = {
      active: true,
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test',
      models: [],
    }
    const keys = hostedImageTargets([openai, requesty]).map((t) => t.key)
    expect(keys).toContain('openai/gpt-image-2.6-flare')
    expect(keys).toContain('requesty/azure/openai/gpt-image-1')
  })
  it('leaves out a built-in provider with no key', () => {
    const openai = { active: true, provider: 'openai', base_url: 'x', api_key: '', models: [] }
    expect(hostedImageTargets([openai])).toEqual([])
  })
})

describe('pickHostedTarget', () => {
  const [one, two] = customCloudTargets([requesty]) as [CloudTarget, CloudTarget]
  it('says what to do when nothing is set up', () => {
    const picked = pickHostedTarget([])
    expect('error' in picked && picked.error).toMatch(/no hosted image model/i)
  })
  it('uses the one last used in Studio while it is still offered', () => {
    expect(pickHostedTarget([one, two], two.key)).toEqual({ target: two })
  })
  it('ignores a remembered model that is gone', () => {
    expect(pickHostedTarget([one], 'requesty/removed')).toEqual({ target: one })
  })
  it('uses the only model when none was chosen', () => {
    expect(pickHostedTarget([two])).toEqual({ target: two })
  })
  it('lists the choices when there are several and none was chosen', () => {
    const picked = pickHostedTarget([one, two])
    expect('error' in picked && picked.error).toContain(one.key)
    expect('error' in picked && picked.error).toContain(two.key)
  })
  it('caps a long list', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...one, key: `p/m${i}` }))
    const picked = pickHostedTarget(many)
    expect('error' in picked && picked.error).toContain('and 4 more')
    expect('error' in picked && picked.error).not.toContain('p/m11')
  })
})

describe('hosted edits', () => {
  const target = customCloudTargets([requesty])[0]

  it('builds the edit URL from the base', () => {
    expect(editsUrl('https://router.requesty.ai/v1/')).toBe('https://router.requesty.ai/v1/images/edits')
    expect(editsUrl('  ')).toBeNull()
    expect(editsUrl(undefined)).toBeNull()
  })

  it('sends the pictures as base64 data URLs, with no response_format', () => {
    const body = buildCloudEditBody(target.provider, target.model, {
      prompt: 'sunset',
      width: 1024,
      height: 1024,
      count: 9,
      sourceImages: ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'],
    })
    expect(body).toEqual({
      model: 'azure/openai/gpt-image-1',
      prompt: 'sunset',
      n: 4,
      size: '1024x1024',
      image: [{ image_url: 'data:image/png;base64,AAAA' }, { image_url: 'data:image/png;base64,BBBB' }],
    })
  })

  const answer = () =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: 'CCCC' }] }),
    })) as unknown as typeof fetch

  it('posts an edit to /images/edits with the key', async () => {
    const fetchImpl = answer()
    await generateCloudImages(
      target,
      { base_url: requesty.base_url, api_key: 'rq-key' },
      { prompt: 'sunset', width: 1024, height: 1024, count: 1, sourceImages: ['data:image/png;base64,AAAA'] },
      new AbortController().signal,
      fetchImpl
    )
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, { headers: Record<string, string>; body: string }][] } }).mock.calls[0]
    expect(url).toBe('https://router.requesty.ai/v1/images/edits')
    expect(init.headers.Authorization).toBe('Bearer rq-key')
    expect(JSON.parse(init.body).image).toEqual([{ image_url: 'data:image/png;base64,AAAA' }])
  })

  it('refuses to edit on a provider that only generates', async () => {
    const other = customCloudTargets([{ ...requesty, provider: 'gateway', base_url: 'https://gw.example.com/v1' }])[0]
    const fetchImpl = answer()
    await expect(
      generateCloudImages(
        other,
        { base_url: 'https://gw.example.com/v1', api_key: 'k' },
        { prompt: 'x', width: 1024, height: 1024, count: 1, sourceImages: ['data:image/png;base64,AAAA'] },
        new AbortController().signal,
        fetchImpl
      )
    ).rejects.toThrow(/cannot edit pictures/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('still generates when no source picture is given', async () => {
    const fetchImpl = answer()
    await generateCloudImages(
      target,
      { base_url: requesty.base_url, api_key: 'rq-key' },
      { prompt: 'a cat', width: 1024, height: 1024, count: 1 },
      new AbortController().signal,
      fetchImpl
    )
    const [url] = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]
    expect(url).toBe('https://router.requesty.ai/v1/images/generations')
  })
})
