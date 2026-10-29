import { invoke as tauriInvoke, type InvokeArgs } from '@tauri-apps/api/core'
import { browserApi, jsonRequest } from '@/services/browserApi'
import { hasTauriRuntime, hasProviderTransport } from '@/lib/providerFetch'
import { previewCall } from '@/lib/previewInvoke'

type RegisterRequest = {
  provider: string
  api_key?: string
  api_keys?: string[]
  custom_headers?: { value: string; secret?: boolean }[]
}

type RestRoute = (args: Record<string, unknown> | undefined) => Promise<unknown>

const keysUrl = (provider: string) => `/api/v1/provider-keys/${encodeURIComponent(provider)}`

const desktopOnly: RestRoute = async () => undefined

/**
 * Commands the Flint server answers over REST. Keys live in the server's
 * keyring or encrypted file, never in the browser's storage.
 */
const REST_ROUTES: Record<string, RestRoute> = {
  get_provider_keys: async (args) =>
    (await browserApi<{ keys: string[] }>(keysUrl(String(args?.provider)))).keys,
  has_provider_keys: async (args) =>
    (await browserApi<{ has: boolean }>(`${keysUrl(String(args?.provider))}/status`)).has,
  export_provider_keys_for_backup: async (args) =>
    (
      await browserApi<{ keys: string[] }>(
        `${keysUrl(String(args?.provider))}/backup`,
        jsonRequest('POST', { confirm: args?.confirm === true })
      )
    ).keys,
  register_provider_config: async (args) => {
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
    return undefined
  },
  delete_provider_keys: async (args) => {
    await browserApi<void>(keysUrl(String(args?.provider)), { method: 'DELETE' })
    return undefined
  },
  // Desktop-only runtime state (the local API server's registry).
  unregister_provider_config: desktopOnly,
  set_provider_tls_trust: desktopOnly,
  set_model_param_defaults: desktopOnly,
}

/** Whether the Flint server answers `command` when there is no Tauri runtime. */
export function hasRestRoute(command: string): boolean {
  return Object.prototype.hasOwnProperty.call(REST_ROUTES, command)
}

/**
 * One entry point for backend commands. In order: the dev preview seed, the
 * Flint server's REST route when the page is served by `flint serve` and the
 * command has one, then the Tauri command (which a `flint serve` page answers
 * through the server's generic RPC route).
 */
export async function invokeCommand<T = unknown>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  const preview = previewCall<T>(command, args as InvokeArgs | undefined)
  if (preview) return preview
  if (!hasTauriRuntime() && hasProviderTransport() && hasRestRoute(command)) {
    return (await REST_ROUTES[command](args)) as T
  }
  // Forwarded as called: a command called with no arguments reaches Tauri
  // with none, not with an explicit `undefined`.
  return args === undefined
    ? tauriInvoke<T>(command)
    : tauriInvoke<T>(command, args as InvokeArgs)
}
