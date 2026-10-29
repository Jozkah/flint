/**
 * Settings backup: build a portable JSON file from the persisted settings
 * stores, and apply one back.
 *
 * The file holds the raw persisted blobs (the same strings the backend settings
 * store keeps), keyed by store name, so a restore is byte-faithful. Only an
 * allowlist of preference stores is exported: chats, sessions, hardware and
 * other per-machine state are not settings and are never touched.
 *
 * Credentials: by default every blob is scrubbed of credential-looking fields
 * and the provider store (and its API keys) is left out. Ticking "include
 * providers and API keys" adds the provider blob and each provider's key chain
 * from the OS keyring.
 */

export const BACKUP_FORMAT = 'flint-settings-backup'
export const BACKUP_VERSION = 1

/** Store holding providers (base URLs, models); its keys live in the keyring. */
export const PROVIDERS_STORE_KEY = 'model-provider'

/**
 * Preference stores that travel between machines. Values match each store's
 * persist `name` (see constants/localStorage.ts and the `flint-*` hooks).
 */
export const BACKUP_STORE_KEYS: readonly string[] = [
  'theme',
  'setting-appearance',
  'setting-general',
  'setting-code-block',
  'setting-proxy-config',
  'setting-web-search',
  'setting-web-preview',
  'setting-agent-tools',
  'setting-visualize',
  'tool-approval',
  'tool-availability',
  'mcp-global-permissions',
  'favorite-models',
  'model-order',
  'model-filter',
  'default-embedding-model',
  'agent-mode',
  'cowork-display',
  'session-messaging',
  'model-overrides',
  'claude-compat',
  'keybindings',
  'reference-aliases',
  'globalExtensions',
  'flint-work-profiles',
  'flint-subagent-settings',
  'flint-model-routing',
  'flint-automation',
  'flint-skill-activation',
  'flint-image-description',
  'flint-jev',
]

export interface SettingsBackup {
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: string
  /** True when provider blobs and API keys are inside. */
  includesSecrets: boolean
  /** Store name to its raw persisted JSON string. */
  settings: Record<string, string>
  /** Provider id to its API key chain. Present only with `includesSecrets`. */
  providerKeys?: Record<string, string[]>
}

/** What the backup reads and writes; injected so the logic is testable. */
export interface BackupIo {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  getProviderKeys(provider: string): Promise<string[]>
  setProviderKeys(provider: string, keys: string[]): Promise<void>
}

export class BackupError extends Error {}

const SECRET_NAME =
  /(api[-_]?keys?|secret|password|passwd|authorization)|(^|[_-])(access_|auth_|refresh_|bearer_|[a-z]+_)?tokens?$/i

const SECRET_HEADER =
  /^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)$|token|secret|key$/i

function snake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
}

/** Drop credential-looking fields, and blank the value of secret custom headers. */
export function stripSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecretFields)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const headerName =
    typeof record.header === 'string'
      ? record.header
      : typeof record.name === 'string'
        ? record.name
        : ''
  const isSecretHeader =
    'value' in record &&
    (record.secret === true || (headerName !== '' && SECRET_HEADER.test(headerName)))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    // `secret: true` on a header row is a flag, not a credential: keep it.
    // A token count is a number, a flag a boolean: neither is a credential.
    if (SECRET_NAME.test(snake(k)) && typeof v !== 'boolean' && typeof v !== 'number') continue
    out[k] = isSecretHeader && k === 'value' ? '' : stripSecretFields(v)
  }
  return out
}

function scrubBlob(raw: string): string {
  try {
    return JSON.stringify(stripSecretFields(JSON.parse(raw)))
  } catch {
    // Not JSON: cannot be scrubbed safely, so it is not exported.
    throw new BackupError('unparseable')
  }
}

function providerIds(blob: string): string[] {
  try {
    const providers = JSON.parse(blob)?.state?.providers
    if (!Array.isArray(providers)) return []
    return providers
      .map((p: { provider?: unknown }) => p?.provider)
      .filter((p): p is string => typeof p === 'string' && p !== 'llamacpp')
  } catch {
    return []
  }
}

export async function buildBackup(
  io: BackupIo,
  opts: { includeSecrets: boolean; now?: Date }
): Promise<SettingsBackup> {
  const settings: Record<string, string> = {}
  for (const key of BACKUP_STORE_KEYS) {
    const raw = await io.get(key)
    if (raw == null) continue
    try {
      settings[key] = scrubBlob(raw)
    } catch {
      // Skip a blob that cannot be scrubbed rather than risk leaking it.
    }
  }

  const backup: SettingsBackup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    includesSecrets: opts.includeSecrets,
    settings,
  }

  if (opts.includeSecrets) {
    const providers = await io.get(PROVIDERS_STORE_KEY)
    if (providers != null) {
      // The blob is already key-free (keys never reach it); still keep it as-is
      // so base URLs, models and per-provider settings round-trip exactly.
      settings[PROVIDERS_STORE_KEY] = providers
      const keys: Record<string, string[]> = {}
      for (const id of providerIds(providers)) {
        const chain = (await io.getProviderKeys(id)).filter(Boolean)
        if (chain.length > 0) keys[id] = chain
      }
      backup.providerKeys = keys
    }
  }
  return backup
}

export function parseBackup(text: string): SettingsBackup {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new BackupError('This file is not valid JSON.')
  }
  const b = data as Partial<SettingsBackup> | null
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT) {
    throw new BackupError('This is not a Flint settings backup.')
  }
  if (typeof b.version !== 'number' || b.version > BACKUP_VERSION) {
    throw new BackupError(
      'This backup was made by a newer version of Flint. Update Flint to import it.'
    )
  }
  if (!b.settings || typeof b.settings !== 'object' || Array.isArray(b.settings)) {
    throw new BackupError('The backup has no settings in it.')
  }
  const settings: Record<string, string> = {}
  for (const [k, v] of Object.entries(b.settings)) {
    // Unknown keys are ignored: a backup can never write outside the allowlist.
    if (!isImportableKey(k) || typeof v !== 'string') continue
    try {
      JSON.parse(v)
    } catch {
      continue
    }
    settings[k] = v
  }
  const providerKeys: Record<string, string[]> = {}
  if (b.providerKeys && typeof b.providerKeys === 'object') {
    for (const [id, chain] of Object.entries(b.providerKeys)) {
      if (id === 'llamacpp' || !Array.isArray(chain)) continue
      const keys = chain.filter((k): k is string => typeof k === 'string' && k !== '')
      if (keys.length > 0) providerKeys[id] = keys
    }
  }
  return {
    format: BACKUP_FORMAT,
    version: b.version,
    exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt : '',
    includesSecrets: b.includesSecrets === true,
    settings,
    ...(Object.keys(providerKeys).length > 0 ? { providerKeys } : {}),
  }
}

function isImportableKey(key: string): boolean {
  return key === PROVIDERS_STORE_KEY || BACKUP_STORE_KEYS.includes(key)
}

/**
 * Stores that decide what runs without asking or where traffic goes: tool
 * auto-approval, MCP trust and the network proxy. A backup file can come from
 * a shared sync folder or another person, so these are only restored when the
 * caller passes `includePermissions` after the user agreed to it.
 */
export const SECURITY_STORE_KEYS: readonly string[] = [
  'tool-approval',
  'mcp-global-permissions',
  'setting-proxy-config',
]

function baseUrls(blob: string | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!blob) return out
  try {
    const providers = JSON.parse(blob)?.state?.providers
    if (!Array.isArray(providers)) return out
    for (const p of providers) {
      if (typeof p?.provider === 'string')
        out.set(p.provider, typeof p.base_url === 'string' ? p.base_url.trim() : '')
    }
  } catch {
    // An unreadable blob names no providers.
  }
  return out
}

/** Per provider: TLS check flag and custom header names (values omitted). */
function transportSettings(
  blob: string | null
): Map<string, { insecureTls: boolean; headers: string }> {
  const out = new Map<string, { insecureTls: boolean; headers: string }>()
  if (!blob) return out
  try {
    const providers = JSON.parse(blob)?.state?.providers
    if (!Array.isArray(providers)) return out
    for (const p of providers) {
      if (typeof p?.provider !== 'string') continue
      const headers = Array.isArray(p.custom_header)
        ? p.custom_header
            .map((h: { header?: unknown; value?: unknown }) =>
              typeof h?.header === 'string'
                ? `${h.header.trim()}=${typeof h.value === 'string' ? h.value : ''}`
                : ''
            )
            .filter(Boolean)
            .sort()
            .join('\n')
        : ''
      out.set(p.provider, { insecureTls: p.allow_invalid_certs === true, headers })
    }
  } catch {
    // An unreadable blob names no providers.
  }
  return out
}

/** What importing `backup` would change that matters for security. */
export interface BackupSecurityPreview {
  /** Providers whose Base URL the backup changes. */
  baseUrlChanges: Array<{
    provider: string
    from: string
    to: string
    /** The saved key is dropped: the backup has none for the new address. */
    keyDropped: boolean
  }>
  /** Providers whose "allow invalid certificates" flag the backup changes. */
  tlsChanges: Array<{ provider: string; insecureTls: boolean }>
  /** Providers whose custom request headers the backup changes (names only). */
  headerChanges: Array<{ provider: string; names: string[] }>
  /** Security stores the backup carries (restored only with permission). */
  securityStores: string[]
}

export async function previewBackupSecurity(
  io: BackupIo,
  backup: SettingsBackup
): Promise<BackupSecurityPreview> {
  const baseUrlChanges: BackupSecurityPreview['baseUrlChanges'] = []
  const providersBlob = backup.settings[PROVIDERS_STORE_KEY]
  if (providersBlob !== undefined) {
    const before = baseUrls(await io.get(PROVIDERS_STORE_KEY))
    for (const [id, url] of baseUrls(providersBlob)) {
      if (id === 'llamacpp' || !before.has(id) || before.get(id) === url)
        continue
      baseUrlChanges.push({
        provider: id,
        from: before.get(id) ?? '',
        to: url,
        keyDropped: !backup.providerKeys?.[id],
      })
    }
  }
  const tlsChanges: BackupSecurityPreview['tlsChanges'] = []
  const headerChanges: BackupSecurityPreview['headerChanges'] = []
  if (providersBlob !== undefined) {
    const before = transportSettings(await io.get(PROVIDERS_STORE_KEY))
    for (const [id, next] of transportSettings(providersBlob)) {
      const prev = before.get(id) ?? { insecureTls: false, headers: '' }
      if (prev.insecureTls !== next.insecureTls)
        tlsChanges.push({ provider: id, insecureTls: next.insecureTls })
      if (prev.headers !== next.headers)
        headerChanges.push({
          provider: id,
          names: next.headers
            ? [...new Set(next.headers.split('\n').map((h) => h.split('=')[0]))]
            : [],
        })
    }
  }
  const securityStores = SECURITY_STORE_KEYS.filter(
    (key) => backup.settings[key] !== undefined
  )
  return { baseUrlChanges, tlsChanges, headerChanges, securityStores }
}

export async function applyBackup(
  io: BackupIo,
  backup: SettingsBackup,
  opts: { includePermissions?: boolean } = {}
): Promise<{ stores: number; providerKeys: number; skipped: string[] }> {
  const skipped: string[] = []
  // A provider whose Base URL the backup changes, with no key of its own in
  // the backup, would send the key already in the keyring to the new address:
  // that key is dropped, so it has to be entered again for the new endpoint.
  const providersBlob = backup.settings[PROVIDERS_STORE_KEY]
  const redirected: string[] = []
  if (providersBlob !== undefined) {
    const before = baseUrls(await io.get(PROVIDERS_STORE_KEY))
    for (const [id, url] of baseUrls(providersBlob)) {
      if (id === 'llamacpp' || backup.providerKeys?.[id]) continue
      if (before.has(id) && before.get(id) !== url) redirected.push(id)
    }
  }
  let stores = 0
  for (const [key, value] of Object.entries(backup.settings)) {
    if (!opts.includePermissions && SECURITY_STORE_KEYS.includes(key)) {
      skipped.push(key)
      continue
    }
    await io.set(key, value)
    stores++
  }
  for (const id of redirected) await io.setProviderKeys(id, [])
  let providerKeys = 0
  for (const [id, keys] of Object.entries(backup.providerKeys ?? {})) {
    await io.setProviderKeys(id, keys)
    providerKeys++
  }
  return { stores, providerKeys, skipped }
}

export function defaultBackupName(now = new Date()): string {
  return `flint-settings-${now.toISOString().slice(0, 10)}.json`
}
