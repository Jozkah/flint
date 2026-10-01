/**
 * Hosted image providers for Studio: the request each one takes and how its
 * answer is read. Everything that decides what is sent or accepted is a pure
 * function here, so it is tested; `generateCloudImages` is the thin part that
 * talks to the network.
 *
 * All of them speak the OpenAI-style `POST {base}/images/generations`. A picture
 * comes back as base64 (preferred) or as a URL, which is downloaded once and
 * kept, so the gallery never depends on a provider's link staying alive.
 */
import { providerFetch } from '@/lib/providerFetch'
import { applyCustomHeaders } from '@/lib/customHeaders'
import { providerRemoteApiKeyChain } from '@/lib/provider-api-keys'
import { snapSide } from '@/lib/studio/helpers'
import { studioApi, type Generated } from '@/lib/studio/studio'

export type CloudImageModel = { id: string; name: string }

export type CloudImageProvider = {
  /** The provider's id in the Providers settings. */
  provider: string
  label: string
  models: CloudImageModel[]
  /** The most pictures one request may ask for. */
  maxCount: number
  /** How a size is sent. */
  size: 'pixels' | 'width-height' | 'aspect-ratio'
  /** Largest side and pixel area the provider accepts. */
  limits: { maxEdge: number; minArea: number; maxArea: number }
  /** What to ask for the picture in: base64 is kept without a second download. */
  format: Record<string, string>
}

export const CLOUD_IMAGE_PROVIDERS: CloudImageProvider[] = [
  {
    provider: 'openai',
    label: 'OpenAI',
    models: [
      { id: 'gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare' },
      { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst' },
    ],
    maxCount: 4,
    size: 'pixels',
    limits: { maxEdge: 3840, minArea: 655_360, maxArea: 8_294_400 },
    // The API returns base64 by default; `response_format` there names a file type.
    format: {},
  },
  {
    provider: 'gemini',
    label: 'Gemini',
    models: [
      { id: 'gemini-2.5-flash-image', name: 'Gemini 2.5 Flash Image' },
      { id: 'gemini-3-pro-image-preview', name: 'Gemini 3 Pro Image (preview)' },
    ],
    maxCount: 4,
    size: 'pixels',
    limits: { maxEdge: 2048, minArea: 0, maxArea: 4_194_304 },
    format: { response_format: 'b64_json' },
  },
  {
    provider: 'xai',
    label: 'xAI',
    models: [{ id: 'grok-imagine-image-2.0', name: 'Grok Imagine Image 2.0' }],
    maxCount: 4,
    size: 'aspect-ratio',
    limits: { maxEdge: 2048, minArea: 0, maxArea: 4_194_304 },
    format: { response_format: 'b64_json' },
  },
  {
    provider: 'together',
    label: 'Together AI',
    models: [
      { id: 'black-forest-labs/FLUX.2-dev', name: 'FLUX.2 dev' },
      { id: 'black-forest-labs/FLUX.1.1-pro', name: 'FLUX.1.1 pro' },
    ],
    maxCount: 4,
    size: 'width-height',
    limits: { maxEdge: 1440, minArea: 0, maxArea: 2_073_600 },
    format: { response_format: 'base64' },
  },
]

/** A choice in the model list: `provider/model`, never a bare model name. */
export function cloudKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

export type CloudTarget = { key: string; provider: CloudImageProvider; model: CloudImageModel }

/** Every hosted model that can be offered, for the providers in `configured`. */
export function cloudTargets(configured: ReadonlySet<string>): CloudTarget[] {
  return CLOUD_IMAGE_PROVIDERS.filter((p) => configured.has(p.provider)).flatMap((provider) =>
    provider.models.map((model) => ({ key: cloudKey(provider.provider, model.id), provider, model }))
  )
}

export function targetFor(key: string, configured: ReadonlySet<string>): CloudTarget | undefined {
  return cloudTargets(configured).find((t) => t.key === key)
}

/**
 * The size nearest to what was asked for that the provider accepts: sides in
 * multiples of 16, the longest side and the picture area inside its limits,
 * the shape kept.
 */
export function fitCloudSize(
  provider: CloudImageProvider,
  width: number,
  height: number
): { width: number; height: number } {
  const { maxEdge, minArea, maxArea } = provider.limits
  let w = width
  let h = height
  const scale = (factor: number) => {
    w *= factor
    h *= factor
  }
  if (Math.max(w, h) > maxEdge) scale(maxEdge / Math.max(w, h))
  if (w * h > maxArea) scale(Math.sqrt(maxArea / (w * h)))
  if (minArea > 0 && w * h < minArea) scale(Math.sqrt(minArea / (w * h)))
  const fit = (n: number) => snapSide(n, 16, maxEdge)
  return { width: fit(w), height: fit(h) }
}

const ASPECT_RATIOS: Array<[number, number]> = [
  [1, 1],
  [4, 3],
  [3, 4],
  [3, 2],
  [2, 3],
  [16, 9],
  [9, 16],
  [21, 9],
]

/** The `w:h` ratio nearest to a size, for providers that take a shape instead of pixels. */
export function nearestAspectRatio(width: number, height: number): string {
  const target = Math.log(width / height)
  let best = ASPECT_RATIOS[0]
  for (const ratio of ASPECT_RATIOS) {
    if (Math.abs(Math.log(ratio[0] / ratio[1]) - target) < Math.abs(Math.log(best[0] / best[1]) - target)) best = ratio
  }
  return `${best[0]}:${best[1]}`
}

export type CloudParams = { prompt: string; width: number; height: number; count: number }

/** The JSON body for one request. */
export function buildCloudBody(
  provider: CloudImageProvider,
  model: CloudImageModel,
  params: CloudParams
): Record<string, unknown> {
  const { width, height } = fitCloudSize(provider, params.width, params.height)
  const body: Record<string, unknown> = {
    model: model.id,
    prompt: params.prompt,
    n: Math.min(Math.max(1, params.count), provider.maxCount),
    ...provider.format,
  }
  if (provider.size === 'pixels') body.size = `${width}x${height}`
  else if (provider.size === 'width-height') Object.assign(body, { width, height })
  else body.aspect_ratio = nearestAspectRatio(width, height)
  return body
}

/** The URL pictures are requested from: the provider's base plus `/images/generations`. */
export function imagesUrl(baseUrl: string | undefined): string | null {
  const base = baseUrl?.trim().replace(/\/+$/, '')
  return base ? `${base}/images/generations` : null
}

export type CloudPicture = { b64?: string; url?: string }

/** The pictures in an answer, and the provider's own words when it refused. */
export function readCloudAnswer(json: unknown): { pictures: CloudPicture[]; error?: string } {
  const root = (json ?? {}) as { data?: unknown; error?: { message?: unknown } | string }
  const error =
    typeof root.error === 'string'
      ? root.error
      : typeof root.error?.message === 'string'
        ? root.error.message
        : undefined
  const data = Array.isArray(root.data) ? root.data : []
  const pictures = data
    .map((entry) => {
      const item = (entry ?? {}) as { b64_json?: unknown; url?: unknown }
      return {
        b64: typeof item.b64_json === 'string' && item.b64_json ? item.b64_json : undefined,
        url: typeof item.url === 'string' && /^https:\/\//.test(item.url) ? item.url : undefined,
      }
    })
    .filter((p) => p.b64 || p.url)
  return { pictures, error }
}

/** A short, plain reason for a refused request. */
export function describeCloudFailure(status: number, providerLabel: string, detail?: string): string {
  const why =
    status === 401 || status === 403
      ? `${providerLabel} did not accept the API key. Check it in Providers.`
      : status === 404
        ? `${providerLabel} does not offer that model on this endpoint.`
        : status === 429
          ? `${providerLabel} is limiting requests right now. Try again in a moment.`
          : status >= 500
            ? `${providerLabel} had a problem on its side (${status}). Try again.`
            : `${providerLabel} refused the request (${status}).`
  return detail ? `${why} ${detail}` : why
}

/** Bytes as base64, in pieces so a large picture does not overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const piece = 0x8000
  for (let i = 0; i < bytes.length; i += piece) {
    binary += String.fromCharCode(...bytes.subarray(i, i + piece))
  }
  return btoa(binary)
}

type Fetch = typeof globalThis.fetch

/**
 * Ask a hosted provider for pictures and keep them in the gallery. `provider`
 * is the provider as configured in settings (its endpoint and API key).
 */
export async function generateCloudImages(
  target: CloudTarget,
  settings: Pick<ProviderObject, 'base_url' | 'api_key' | 'api_key_fallbacks' | 'custom_header'>,
  params: CloudParams,
  signal: AbortSignal,
  fetchImpl: Fetch = providerFetch
): Promise<Generated> {
  const started = Date.now()
  const url = imagesUrl(settings.base_url)
  const key = providerRemoteApiKeyChain(settings)[0]
  if (!url) throw new Error(`${target.provider.label} has no endpoint set. Check it in Providers.`)
  if (!key) throw new Error(`${target.provider.label} has no API key. Add one in Providers.`)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  }
  applyCustomHeaders(headers, settings)

  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildCloudBody(target.provider, target.model, params)),
    signal,
  })
  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  const answer = readCloudAnswer(json)
  if (!response.ok) throw new Error(describeCloudFailure(response.status, target.provider.label, answer.error))
  if (answer.pictures.length === 0) {
    throw new Error(answer.error ?? `${target.provider.label} returned no pictures.`)
  }

  const images: string[] = []
  for (const picture of answer.pictures) {
    if (picture.b64) {
      images.push(picture.b64)
      continue
    }
    // A URL answer: fetched once, so the gallery does not depend on the link.
    const download = await fetchImpl(picture.url as string, { signal, headers: { 'User-Agent': 'Flint' } })
    if (!download.ok) throw new Error(`${target.provider.label}'s picture could not be downloaded (${download.status}).`)
    images.push(bytesToBase64(new Uint8Array(await download.arrayBuffer())))
  }

  const { width, height } = fitCloudSize(target.provider, params.width, params.height)
  return studioApi.saveExternalImages({
    prompt: params.prompt,
    width,
    height,
    modelId: target.key,
    modelName: `${target.model.name} · ${target.provider.label}`,
    durationMs: Date.now() - started,
    images,
  })
}
