/**
 * The model-list request for one key, built the way the model list in
 * Settings sends it. The key test in Settings uses this too, so a key that
 * works for a real request also passes the test: Anthropic needs
 * `anthropic-version` and `x-api-key`, Azure needs `api-key` and an
 * `api-version`. janhq/jan#9440.
 */
import {
  applyProviderAuthHeader,
  ensureAnthropicHeaders,
} from '@/lib/anthropicHeaders'
import { applyCustomHeaders } from '@/lib/customHeaders'
import { modelsUrlCandidates } from '@/lib/modelsUrl'
import {
  azureApiVersionSetting,
  isAzureOpenAIProvider,
  splitBaseUrlQuery,
} from '@/lib/model-factory'

type ProviderLike = Parameters<typeof isAzureOpenAIProvider>[0] &
  Parameters<typeof azureApiVersionSetting>[0] &
  Parameters<typeof applyCustomHeaders>[1] & { api_type?: string }

export function buildProviderListRequest(
  provider: ProviderLike & { base_url: string },
  key: string | undefined
): { headers: Record<string, string>; urls: string[] } {
  const azure = isAzureOpenAIProvider(provider)
  let listBase = provider.base_url
  let listQuery = ''
  if (azure) {
    const split = splitBaseUrlQuery(provider.base_url)
    const params = { ...split.queryParams }
    if (!params['api-version']) {
      const version = azureApiVersionSetting(provider)
      if (version) params['api-version'] = version
    }
    listBase = split.baseURL
    listQuery = new URLSearchParams(params).toString()
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (
    provider.base_url.includes('localhost:') ||
    provider.base_url.includes('127.0.0.1:')
  ) {
    headers['Origin'] = 'tauri://localhost'
  }
  applyProviderAuthHeader(provider, headers, key)
  if (azure && key) headers['api-key'] = key
  // After the key: reserved names are never applied, so a custom header
  // cannot replace it. janhq/jan#8208.
  applyCustomHeaders(headers, provider)
  ensureAnthropicHeaders(provider, headers)

  const urls = modelsUrlCandidates(listBase).map((u) =>
    listQuery ? `${u}?${listQuery}` : u
  )
  return { headers, urls }
}
