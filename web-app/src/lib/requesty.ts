/**
 * Requesty is an OpenAI-compatible router with two extra lists: `/models` names
 * the chat models, `/models/image` the picture models and `/models/decision`
 * the decision models (typed-question models answered at `/systemone`), which
 * `/models` leaves out. They are fetched from there so they appear without the
 * user adding each one by hand.
 */

type ProviderLike = { provider: string; base_url?: string }

/** The provider is Requesty: by id, or by a base URL that points at it. */
export function isRequestyProvider(provider: ProviderLike): boolean {
  if (provider.provider === 'requesty') return true
  try {
    const host = new URL(provider.base_url ?? '').hostname.toLowerCase()
    return host === 'requesty.ai' || host.endsWith('.requesty.ai')
  } catch {
    return false
  }
}

/** Where the decision models approved for the key are listed, or null. */
export function decisionModelsUrl(baseUrl: string | undefined): string | null {
  const base = baseUrl?.trim().replace(/\/+$/, '')
  return base ? `${base}/models/decision` : null
}

/** Where the picture models are listed, or null without an endpoint. */
export function imageModelsUrl(baseUrl: string | undefined): string | null {
  const base = baseUrl?.trim().replace(/\/+$/, '')
  return base ? `${base}/models/image` : null
}
