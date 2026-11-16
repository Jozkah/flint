/**
 * Requesty is an OpenAI-compatible router with one extra list: `/models` names
 * the chat models and `/models/image` the picture models, which `/models`
 * leaves out. Picture models are fetched from there so they appear without the
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

/** Where the picture models are listed, or null without an endpoint. */
export function imageModelsUrl(baseUrl: string | undefined): string | null {
  const base = baseUrl?.trim().replace(/\/+$/, '')
  return base ? `${base}/models/image` : null
}
