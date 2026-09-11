/**
 * Where the values of secret custom headers live. janhq/jan#8208.
 *
 * The same credential store as the provider's API keys (the OS keyring, or
 * the encrypted file where there is none), under a key of its own. Settings
 * keep the header's name and a blank value; the value is read back into
 * memory at startup, the way the keys are.
 *
 * One entry per provider holding every secret value, not one per header:
 * macOS asks once per keychain entry.
 */
import { invoke } from '@tauri-apps/api/core'

/** Kept apart from the provider's own key chain, which is keyed by its name. */
export function headerSecretsKey(provider: string): string {
  return `provider-headers:${provider}`
}

const nameKey = (header: string) => header.trim().toLowerCase()

/**
 * Replace the provider's stored secret values with those in `rows`. Removes
 * the entry when no row is secret. Throws when the store cannot be written:
 * the caller must not report the header saved.
 */
export async function storeSecretHeaderValues(
  provider: string,
  rows: ProviderCustomHeader[]
): Promise<void> {
  const values: Record<string, string> = {}
  for (const h of rows) {
    if (h.secret && h.value.trim()) values[nameKey(h.header)] = h.value.trim()
  }
  await invoke('set_secret', {
    key: headerSecretsKey(provider),
    value: Object.keys(values).length > 0 ? JSON.stringify(values) : '',
  })
}

/** The provider's stored secret values by lower-case name; empty on failure. */
export async function loadSecretHeaderValues(
  provider: string
): Promise<Record<string, string>> {
  try {
    const raw = await invoke<string | null>('get_secret', {
      key: headerSecretsKey(provider),
    })
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') return {}
      out[name] = value
    }
    return out
  } catch {
    return {}
  }
}

/** `rows` with each secret row's value taken from `values`. */
export function fillSecretHeaderValues(
  rows: ProviderCustomHeader[],
  values: Record<string, string>
): ProviderCustomHeader[] {
  return rows.map((h) =>
    h.secret ? { ...h, value: values[nameKey(h.header)] ?? '' } : h
  )
}

/** Forget the provider's secret values. For removing the provider. */
export async function deleteSecretHeaderValues(provider: string): Promise<void> {
  await invoke('set_secret', { key: headerSecretsKey(provider), value: '' })
}
