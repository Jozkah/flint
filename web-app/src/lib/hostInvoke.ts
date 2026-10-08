import { invoke } from '@tauri-apps/api/core'
import { browserApi, jsonRequest } from '@/services/browserApi'
import { hasTauriRuntime, hasProviderTransport } from '@/lib/providerFetch'

type RegisterRequest = {
  provider: string
  api_key?: string
  api_keys?: string[]
  custom_headers?: { value: string; secret?: boolean }[]
}

const keysUrl = (provider: string) => `/api/v1/provider-keys/${encodeURIComponent(provider)}`

/**
 * `invoke` for the provider-credential commands, answered by the Flint server
 * when the page is served by `flint serve`. Keys live in the server's keyring
 * or encrypted file, never in the browser's storage.
 */
export async function hostInvoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (hasTauriRuntime() || !hasProviderTransport()) {
    return invoke<T>(command, args)
  }
  switch (command) {
    case 'get_provider_keys': {
      const result = await browserApi<{ keys: string[] }>(keysUrl(String(args?.provider)))
      return result.keys as T
    }
    case 'register_provider_config': {
      const request = args?.request as RegisterRequest
      const keys = [request.api_key, ...(request.api_keys ?? [])].filter(
        (key): key is string => !!key && key.trim() !== ''
      )
      const secrets = (request.custom_headers ?? [])
        .filter((header) => header.secret)
        .map((header) => header.value)
      if (secrets.length) {
        await browserApi<void>('/api/v1/secret-values', jsonRequest('POST', { values: secrets }))
      }
      // An empty chain deletes, as on desktop; the request is the source of truth.
      await browserApi<void>(keysUrl(request.provider), jsonRequest('PUT', { keys }))
      return undefined as T
    }
    case 'delete_provider_keys':
      await browserApi<void>(keysUrl(String(args?.provider)), { method: 'DELETE' })
      return undefined as T
    case 'unregister_provider_config':
    case 'set_model_param_defaults':
      // Desktop-only runtime state (the local API server's registry).
      return undefined as T
    default:
      return invoke<T>(command, args)
  }
}
