/**
 * The window an Ollama server really runs a model in (janhq/jan#9476).
 *
 * Ollama's OpenAI-compatible `/v1/chat/completions` keeps only the newest
 * `num_ctx` tokens of a prompt and drops the rest without an error, and its
 * default `num_ctx` is far below what most models were trained for. Flint
 * sends the whole history, but planned compaction against the model's
 * theoretical window, so the oldest turns were cut by the server instead:
 * "context seems lost on each message".
 *
 * Ollama names its real window in its native API, not in `/v1/models`:
 * - `GET /api/ps`: each loaded model's `context_length` (what it runs at now).
 * - `POST /api/show`: `parameters` carries `num_ctx` when a Modelfile sets it.
 * The model's trained maximum (`model_info["<arch>.context_length"]`) is not
 * what Ollama runs at, so it is never taken as the window.
 */
import { providerFetch } from '@/lib/providerFetch'
import { usableContextValue } from '@/lib/modelCapabilities'

type OllamaLike = {
  provider?: string | null
  name?: string | null
  base_url?: string | null
}

const OLLAMA_PORT = '11434'

/** A provider named Ollama, or one on Ollama's default port. */
export function isOllamaProvider(provider: OllamaLike | null | undefined): boolean {
  if (!provider) return false
  const named = [provider.provider, provider.name].some((v) =>
    typeof v === 'string' ? v.toLowerCase().includes('ollama') : false
  )
  if (named) return true
  try {
    return new URL(provider.base_url ?? '').port === OLLAMA_PORT
  } catch {
    return false
  }
}

/** `http://host:11434`, from a base URL that may end in `/v1`. */
export function ollamaOrigin(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null
  try {
    return new URL(baseUrl).origin
  } catch {
    return null
  }
}

/** Ollama names a model `llama3` and `llama3:latest` interchangeably. */
const sameModel = (a: unknown, modelId: string) => {
  if (typeof a !== 'string') return false
  const norm = (s: string) => (s.includes(':') ? s : `${s}:latest`)
  return a === modelId || norm(a) === norm(modelId)
}

/** The loaded window of `modelId` out of an `/api/ps` body. */
export function parsePsWindow(body: unknown, modelId: string): number | null {
  if (!body || typeof body !== 'object') return null
  const models = (body as Record<string, unknown>).models
  if (!Array.isArray(models)) return null
  const entry = models.find(
    (m): m is Record<string, unknown> =>
      !!m &&
      typeof m === 'object' &&
      (sameModel((m as Record<string, unknown>).name, modelId) ||
        sameModel((m as Record<string, unknown>).model, modelId))
  )
  return entry ? usableContextValue(entry.context_length) : null
}

/** The `num_ctx` a Modelfile sets, out of an `/api/show` body. */
export function parseShowWindow(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null
  const params = (body as Record<string, unknown>).parameters
  if (typeof params !== 'string') return null
  const match = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(params)
  return match ? usableContextValue(Number(match[1])) : null
}

const TTL_MS = 60_000
const TIMEOUT_MS = 3_000
const cache = new Map<string, { at: number; tokens: number | null }>()
const inFlight = new Map<string, Promise<number | null>>()

async function askJson(
  url: string,
  init: { method: 'GET' | 'POST'; body?: string },
  headers?: Record<string, string>
): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await providerFetch(url, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers ?? {}),
      },
      signal: controller.signal,
    })
    return response.ok ? await response.json() : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask an Ollama server the window it runs `modelId` in: the loaded context
 * from `/api/ps`, else a Modelfile's `num_ctx` from `/api/show`. Null when it
 * did not answer or names neither; never throws. Remembered for a minute.
 */
export async function fetchOllamaWindow(
  baseUrl: string | null | undefined,
  modelId: string | null | undefined,
  headers?: Record<string, string>
): Promise<number | null> {
  const origin = ollamaOrigin(baseUrl)
  if (!origin || !modelId) return null
  const key = `${origin}|${modelId}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tokens
  const pending = inFlight.get(key)
  if (pending) return pending

  const request = (async () => {
    const loaded = parsePsWindow(
      await askJson(`${origin}/api/ps`, { method: 'GET' }, headers),
      modelId
    )
    if (loaded != null) return loaded
    return parseShowWindow(
      await askJson(
        `${origin}/api/show`,
        { method: 'POST', body: JSON.stringify({ model: modelId }) },
        headers
      )
    )
  })()
  inFlight.set(key, request)
  try {
    const tokens = await request
    cache.set(key, { at: Date.now(), tokens })
    return tokens
  } finally {
    inFlight.delete(key)
  }
}

/** Share of the window at which the truncation notice shows. */
export const OLLAMA_NOTICE_RATIO = 0.9
const noticed = new Set<string>()

/**
 * True once per chat and model, the first time a prompt reaches the share of
 * the Ollama window where the server starts cutting the oldest messages.
 */
export function shouldNoticeOllamaTruncation(
  key: string,
  promptTokens: number,
  window: number | null | undefined
): boolean {
  if (!window || window <= 0 || noticed.has(key)) return false
  if (promptTokens < window * OLLAMA_NOTICE_RATIO) return false
  noticed.add(key)
  return true
}

/** Forget what was learned and noticed, for tests. */
export function resetOllamaWindowState(): void {
  cache.clear()
  inFlight.clear()
  noticed.clear()
}
