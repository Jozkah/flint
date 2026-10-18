export const API_KEY_FALLBACKS_SETTING_KEY = 'api-key-fallbacks'

export function serializeApiKeyFallbacks(fallbacks: string[]): string {
  return fallbacks.map((k) => k.trim()).filter((k) => k.length > 0).join('\n')
}

export function parseApiKeyFallbacks(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  return value
    .split(/\r?\n/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
}

/**
 * Ordered API keys for a remote provider: primary `api_key` first, then `api_key_fallbacks`.
 */
export function providerRemoteApiKeyChain(provider: {
  api_key?: string
  api_key_fallbacks?: string[]
}): string[] {
  const primary = provider.api_key?.trim()
  const fallbacks = (provider.api_key_fallbacks ?? [])
    .map((k) => String(k).trim())
    .filter((k) => k.length > 0)
  const ordered = [...(primary ? [primary] : []), ...fallbacks]
  const seen = new Set<string>()
  return ordered.filter((k) => {
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function providerHasRemoteApiKeys(provider: {
  api_key?: string
  api_key_fallbacks?: string[]
}): boolean {
  return providerRemoteApiKeyChain(provider).length > 0
}

/**
 * What a read of the OS keyring may change in memory. The keyring only fills a
 * provider that has no key in memory yet (the store holds none after a reload).
 * A key already in memory is the user's latest (typed, imported) and is
 * written to the keyring by the provider sync, so a keyring read that finished
 * late, or an older read, must not put an earlier key back over it.
 */
export function keyringKeysToApply(
  current: { api_key?: string; api_key_fallbacks?: string[] } | undefined,
  seeded: { api_key?: string; api_key_fallbacks?: string[] }
): { api_key: string; api_key_fallbacks?: string[] } | null {
  if (!seeded.api_key) return null
  if (current?.api_key?.trim()) return null
  return { api_key: seeded.api_key, api_key_fallbacks: seeded.api_key_fallbacks }
}
