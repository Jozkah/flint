import { providerFetch } from '@/lib/providerFetch'
import { providerRemoteApiKeyChain } from '@/lib/provider-api-keys'
import { applyCustomHeaders } from '@/lib/customHeaders'
import { reportedDefaults } from '@/lib/modelReportedDefaults'

/**
 * The sampling values a self-hosted OpenAI-compatible server would apply to a
 * request that sets none.
 *
 * vLLM does not list them with its models, but its `/chat/completions/render`
 * endpoint turns a request into what would be run and returns the effective
 * `sampling_params`, with the model's `generation_config.json` applied. Asking
 * it for one word of prompt costs nothing: it generates nothing. A server
 * without that endpoint answers 404 and the answer is simply empty.
 *
 * Only servers on the user's own network are asked. A hosted provider gets no
 * extra request from a settings menu, and would not have the endpoint anyway.
 */

/** localhost, a loopback or private address, `.local`/`.lan`, or a bare hostname. */
export function isOwnServer(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === 'localhost' || host === '[::1]' || host.endsWith('.localhost'))
    return true
  if (
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    host.endsWith('.internal')
  )
    return true
  // A bare name such as v100.
  if (!host.includes('.') && !host.includes(':')) return true
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31)
  )
}

/** vLLM's names onto Flint's; `max_tokens` there is the context left, not a cap. */
export function fromRenderedParams(
  sampling: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!sampling || typeof sampling !== 'object') return {}
  const mapped: Record<string, unknown> = { ...sampling }
  delete mapped.max_tokens
  if (mapped.repetition_penalty !== undefined) {
    mapped.repeat_penalty = mapped.repetition_penalty
    delete mapped.repetition_penalty
  }
  // vLLM writes "off" as 0 or -1 for top_k.
  if (typeof mapped.top_k === 'number' && mapped.top_k <= 0) delete mapped.top_k
  return reportedDefaults(mapped)
}

type ProviderLike = {
  provider?: string
  base_url?: string
  api_key?: string
  api_key_fallbacks?: string[]
  custom_header?: unknown
}

const cache = new Map<string, Promise<Record<string, unknown>>>()

export function fetchRemoteSamplingDefaults(
  provider: ProviderLike | undefined,
  modelId: string | undefined
): Promise<Record<string, unknown>> {
  if (!provider?.base_url || !modelId || !isOwnServer(provider.base_url)) {
    return Promise.resolve({})
  }
  const key = `${provider.base_url}|${modelId}`
  const hit = cache.get(key)
  if (hit) return hit
  const base = provider.base_url.replace(/\/+$/, '')
  const pending = (async () => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      const apiKey = providerRemoteApiKeyChain(provider)[0]
      if (apiKey) {
        headers['x-api-key'] = apiKey
        headers.Authorization = `Bearer ${apiKey}`
      }
      applyCustomHeaders(headers, provider as never)
      const res = await providerFetch(`${base}/chat/completions/render`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
      if (!res.ok) return {}
      const json = await res.json()
      const first = Array.isArray(json) ? json[0] : json
      return fromRenderedParams(first?.sampling_params)
    } catch {
      return {}
    }
  })()
  cache.set(key, pending)
  // A failure is not remembered: the server may just not be up yet.
  void pending.then((v) => {
    if (Object.keys(v).length === 0) cache.delete(key)
  })
  return pending
}
