import { getServiceHub } from '@/hooks/useServiceHub'

/**
 * Secrets held by a persisted settings store live in the OS keyring (via the
 * `set_secret`/`get_secret` commands), never in the store's blob: that blob is
 * written in plaintext to `settings.json`, whose contract is "secrets never
 * land here". A store omits the secret from its `partialize`, writes it with
 * `persistStoreSecret`, and is re-seeded from `readStoreSecret` at startup.
 */

/** Keyring key for the Local API Server key. */
export const LOCAL_API_SERVER_KEY_SECRET = 'local-api-server-key'
/** Keyring key for the HTTPS proxy password. */
export const PROXY_PASSWORD_SECRET = 'proxy-password'

type Invoke = <T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
) => Promise<T>

function invoker(): Invoke | null {
  try {
    const core = getServiceHub().core()
    return core.invoke.bind(core) as Invoke
  } catch {
    // The ServiceHub is not ready (tests, very early startup): nothing to do.
    return null
  }
}

/**
 * Store (or, for an empty value, delete) a secret in the keyring. Resolves
 * true only when the keyring accepted the write.
 */
export async function persistStoreSecret(
  key: string,
  value: string
): Promise<boolean> {
  const invoke = invoker()
  if (!invoke) return false
  try {
    await invoke('set_secret', { key, value })
    return true
  } catch (err) {
    console.warn(`Failed to persist ${key} to the keyring:`, err)
    return false
  }
}

/** Read a secret from the keyring; `null` when absent or unavailable. */
export async function readStoreSecret(key: string): Promise<string | null> {
  const invoke = invoker()
  if (!invoke) return null
  try {
    return (await invoke<string | null>('get_secret', { key })) ?? null
  } catch {
    return null
  }
}

/**
 * Move a secret field out of a persisted state object into the keyring and
 * delete it from the object. For store `migrate` steps and the one-time
 * localStorage migration, so a key an older build wrote in plaintext is not
 * left in `settings.json`. When the keyring write fails the field is kept, so
 * the secret is never dropped.
 */
export async function moveFieldToKeyring(
  state: Record<string, unknown> | undefined,
  field: string,
  secretKey: string,
  invoke?: Invoke
): Promise<void> {
  if (!state) return
  const value = state[field]
  if (typeof value === 'string' && value.length > 0) {
    if (invoke) {
      await invoke('set_secret', { key: secretKey, value })
    } else if (!(await persistStoreSecret(secretKey, value))) {
      // Keyring unavailable: keep the field so the secret is not lost.
      return
    }
  }
  delete state[field]
}
