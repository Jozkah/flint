import { requestUrlOf } from '@/lib/model/transportErrors'

/** A 400/422 whose message blames the reasoning parameter. */
const REASONING_COMPLAINT =
  /reasoning|effort|thinking|unknown (parameter|field)|unrecognized (request )?(argument|parameter|field)|unsupported (parameter|value)|extra inputs/i

/**
 * Retries a chat request once without `reasoning_effort` / `reasoning` when the
 * server refuses it, so a default effort can never leave a model unusable. The
 * caller learns of the refusal (to keep the default off for that model); the
 * answer of the retry is returned. Other failures pass through untouched.
 */
export function withReasoningRejectionRetry(
  baseFetch: typeof globalThis.fetch,
  onRejected: () => void
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init)
    if (
      (response.status !== 400 && response.status !== 422) ||
      typeof init?.body !== 'string' ||
      !/[/](chat[/]completions|responses)([?]|$)/.test(requestUrlOf(input))
    ) {
      return response
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(init.body) as Record<string, unknown>
    } catch {
      return response
    }
    if (!('reasoning_effort' in body) && !('reasoning' in body)) return response
    let text = ''
    try {
      text = await response.clone().text()
    } catch {
      return response
    }
    if (!REASONING_COMPLAINT.test(text)) return response
    delete body.reasoning_effort
    delete body.reasoning
    const retry = await baseFetch(input, { ...init, body: JSON.stringify(body) })
    if (retry.ok) onRejected()
    return retry
  }
}

/** Keep the implicit default off for a model whose server refused it. */
export function rememberReasoningRejected(
  providerName: string,
  modelId: string
): void {
  void (async () => {
    try {
      const { useModelProvider } = await import('@/hooks/useModelProvider')
      const state = useModelProvider.getState()
      const current = state.providers.find((p) => p.provider === providerName)
      if (!current) return
      state.updateProvider(providerName, {
        models: current.models.map((m) =>
          m.id === modelId ? { ...m, reasoningRejected: true } : m
        ),
      })
    } catch (e) {
      console.warn('[reasoning] could not remember the refusal:', e)
    }
  })()
}
