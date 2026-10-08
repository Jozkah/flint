import { describe, it, expect } from 'vitest'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupError,
  applyBackup,
  buildBackup,
  parseBackup,
  stripSecretFields,
  type BackupIo,
} from '../settings-backup'

function fakeIo(initial: Record<string, string>, keys: Record<string, string[]> = {}) {
  const store = new Map(Object.entries(initial))
  const keyring = new Map(Object.entries(keys))
  const io: BackupIo = {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
    getProviderKeys: async (p) => keyring.get(p) ?? [],
    setProviderKeys: async (p, v) => void keyring.set(p, v),
  }
  return { io, store, keyring }
}

const providers = JSON.stringify({
  state: {
    providers: [
      { provider: 'llamacpp', models: [] },
      { provider: 'openai', base_url: 'https://api.openai.com/v1' },
      { provider: 'nokey' },
    ],
  },
})

describe('stripSecretFields', () => {
  it('drops credential fields at any depth and blanks secret headers', () => {
    const out = stripSecretFields({
      theme: 'dark',
      apiKeys: { exa: 'k' },
      proxy: { url: 'http://x', proxyPassword: 'p' },
      maxTokens: 100,
      access_token: 't',
      custom_header: [
        { header: 'X-A', value: 'public', secret: false },
        { header: 'X-B', value: 'hush', secret: true },
      ],
    })
    expect(out).toEqual({
      theme: 'dark',
      proxy: { url: 'http://x' },
      maxTokens: 100,
      custom_header: [
        { header: 'X-A', value: 'public', secret: false },
        { header: 'X-B', value: '', secret: true },
      ],
    })
  })
})

describe('buildBackup', () => {
  it('exports allowlisted stores only, scrubbed, without providers by default', async () => {
    const { io } = fakeIo(
      {
        theme: '{"state":{"isDark":true}}',
        'setting-web-search': '{"state":{"apiKeys":{"exa":"sk-1"},"on":true}}',
        threads: '{"state":{"threads":[]}}',
        'model-provider': providers,
      },
      { openai: ['sk-live'] }
    )
    const b = await buildBackup(io, { includeSecrets: false })
    expect(Object.keys(b.settings).sort()).toEqual(['setting-web-search', 'theme'])
    expect(b.settings['setting-web-search']).not.toContain('sk-1')
    expect(b.includesSecrets).toBe(false)
    expect(b.providerKeys).toBeUndefined()
    expect(JSON.stringify(b)).not.toContain('sk-live')
  })

  it('includes providers and their keys when asked, skipping llamacpp and keyless', async () => {
    const { io } = fakeIo({ 'model-provider': providers }, { openai: ['sk-a', 'sk-b'] })
    const b = await buildBackup(io, { includeSecrets: true })
    expect(b.settings['model-provider']).toBe(providers)
    expect(b.providerKeys).toEqual({ openai: ['sk-a', 'sk-b'] })
    expect(b.includesSecrets).toBe(true)
  })

  it('skips a blob that is not JSON instead of exporting it raw', async () => {
    const { io } = fakeIo({ theme: 'sk-not-json' })
    const b = await buildBackup(io, { includeSecrets: false })
    expect(b.settings).toEqual({})
  })
})

describe('parseBackup', () => {
  const ok = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: 'x',
    settings: { theme: '{}' },
  }

  it('rejects non-JSON, foreign files and newer versions', () => {
    expect(() => parseBackup('nope')).toThrow(BackupError)
    expect(() => parseBackup('{"a":1}')).toThrow(/not a Flint/)
    expect(() => parseBackup(JSON.stringify({ ...ok, version: 99 }))).toThrow(/newer/)
    expect(() => parseBackup(JSON.stringify({ ...ok, settings: [] }))).toThrow(/no settings/)
  })

  it('drops keys outside the allowlist and values that are not JSON', () => {
    const parsed = parseBackup(
      JSON.stringify({
        ...ok,
        settings: { theme: '{}', threads: '{}', keybindings: 'not json', evil: '{}' },
      })
    )
    expect(Object.keys(parsed.settings)).toEqual(['theme'])
  })

  it('keeps provider keys but never for llamacpp or with empty entries', () => {
    const parsed = parseBackup(
      JSON.stringify({
        ...ok,
        providerKeys: { openai: ['a', '', 3], llamacpp: ['x'], empty: [] },
      })
    )
    expect(parsed.providerKeys).toEqual({ openai: ['a'] })
  })
})

describe('round trip', () => {
  it('restores stores and keys into a fresh machine', async () => {
    const src = fakeIo(
      { theme: '{"state":{"isDark":true}}', 'model-provider': providers },
      { openai: ['sk-live'] }
    )
    const text = JSON.stringify(await buildBackup(src.io, { includeSecrets: true }))

    const dst = fakeIo({})
    const result = await applyBackup(dst.io, parseBackup(text))

    expect(result).toEqual({ stores: 2, providerKeys: 1 })
    expect(dst.store.get('theme')).toBe('{"state":{"isDark":true}}')
    expect(dst.store.get('model-provider')).toBe(providers)
    expect(dst.keyring.get('openai')).toEqual(['sk-live'])
  })
})
