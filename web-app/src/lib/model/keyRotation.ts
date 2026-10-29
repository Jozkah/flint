/** API key rotation over the custom fetch wrapper. */
import { createCustomFetch } from './customFetch'

export type ApiKeyHeaderMode =
  | 'authorization-bearer'
  | 'authorization-bearer+api-key'
  | 'x-api-key'
  | 'x-goog-api-key'

/**
 * Retries with the next key when the upstream returns 401, 402, or 429.
 * A key that was refused is skipped for a while and the last one that worked
 * is tried first, so a dead key at the head of the list costs one request
 * instead of one per call. A 403 is a permission answer about the model or
 * region, not about the key, and is returned as it is.
 */
export function createApiKeyRotatingFetch(
  baseFetch: typeof globalThis.fetch,
  apiKeys: string[],
  parameters: Record<string, unknown>,
  headerMode: ApiKeyHeaderMode,
  filterNamedSseEvents = false
): typeof globalThis.fetch {
  const inner = createCustomFetch(
    baseFetch,
    parameters,
    false,
    undefined,
    filterNamedSseEvents
  )
  if (apiKeys.length <= 1) {
    return inner
  }
  let preferred = 0
  const badUntil: number[] = apiKeys.map(() => 0)
  return async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const total = apiKeys.length
    const now = Date.now()
    const order: number[] = []
    for (let k = 0; k < total; k++) {
      const idx = (preferred + k) % total
      if (badUntil[idx]! <= now) order.push(idx)
    }
    // Every key is on the bench: try them all in order anyway.
    if (order.length === 0) {
      for (let k = 0; k < total; k++) order.push((preferred + k) % total)
    }
    for (let pos = 0; pos < order.length; pos++) {
      const i = order[pos]!
      const key = apiKeys[i]!
      const nextHeaders = new Headers(init?.headers as HeadersInit | undefined)
      if (headerMode === 'authorization-bearer') {
        nextHeaders.set('Authorization', `Bearer ${key}`)
      } else if (headerMode === 'authorization-bearer+api-key') {
        nextHeaders.set('Authorization', `Bearer ${key}`)
        nextHeaders.set('api-key', key)
      } else if (headerMode === 'x-goog-api-key') {
        nextHeaders.set('x-goog-api-key', key)
      } else {
        nextHeaders.set('x-api-key', key)
      }
      const res = await inner(input, { ...init, headers: nextHeaders })
      if ([401, 402, 429].includes(res.status)) {
        let benchMs = 10 * 60_000
        if (res.status === 429) {
          const seconds = Number(res.headers?.get('retry-after'))
          benchMs =
            Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000
        }
        badUntil[i] = Date.now() + benchMs
        if (pos < order.length - 1) {
          res.body?.cancel().catch(() => {})
          continue
        }
        return res
      }
      preferred = i
      return res
    }
    throw new Error('API key rotation exhausted')
  }
}
