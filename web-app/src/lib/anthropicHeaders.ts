/**
 * Headers an Anthropic-shaped provider needs before it will answer.
 *
 * Kept when the remote model catalogue was removed: these are not discovery,
 * they are what a request the user deliberately configured has to carry. No
 * request is made from here — this only fills in defaults on headers a caller
 * is already about to send.
 */

const ANTHROPIC_VERSION_HEADER = 'anthropic-version'
const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_BROWSER_ACCESS_HEADER =
  'anthropic-dangerous-direct-browser-access'

/// Whether a provider fronts Anthropic's API. The `api_type` discriminant is
/// authoritative (matches the inference dispatch in model-factory); provider
/// name and host are fallbacks for configs predating that field.
function isAnthropicProvider(provider: {
  provider?: string
  base_url?: string
  api_type?: string
}): boolean {
  return (
    provider.api_type === 'anthropic' ||
    (provider.provider ?? '').toLowerCase().includes('anthropic') ||
    (provider.base_url ?? '').toLowerCase().includes('anthropic')
  )
}

/// The one auth header a model-list or key-test request carries. Anthropic
/// authenticates with `x-api-key`; every other provider takes
/// `Authorization: Bearer`. Sending both breaks upstreams that reject mixed
/// auth (AWS Bedrock answers 401).
export function applyProviderAuthHeader(
  provider: { provider?: string; base_url?: string; api_type?: string },
  headers: Record<string, string>,
  key: string | undefined
): void {
  if (!key) return
  if (isAnthropicProvider(provider)) {
    headers['x-api-key'] = key
  } else {
    headers['Authorization'] = `Bearer ${key}`
  }
}

function setDefaultHeader(
  headers: Record<string, string>,
  name: string,
  value: string
): void {
  const present = Object.keys(headers).some(
    (h) => h.toLowerCase() === name.toLowerCase()
  )
  if (!present) headers[name] = value
}

/// Anthropic rejects requests without `anthropic-version`, and rejects those
/// carrying an `Origin` (this webview is a browser context) without the
/// browser-access opt-in header. Add both defaults for Anthropic providers
/// when the caller hasn't set them; other providers are left untouched.
export function ensureAnthropicHeaders(
  provider: { provider?: string; base_url?: string; api_type?: string },
  headers: Record<string, string>
): void {
  if (!isAnthropicProvider(provider)) return
  setDefaultHeader(headers, ANTHROPIC_VERSION_HEADER, ANTHROPIC_VERSION)
  setDefaultHeader(headers, ANTHROPIC_BROWSER_ACCESS_HEADER, 'true')
}
