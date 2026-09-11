import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map<string, string>()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: { key: string; value?: string }) => {
    if (cmd === 'set_secret') {
      if (args.value) store.set(args.key, args.value)
      else store.delete(args.key)
      return null
    }
    if (cmd === 'get_secret') return store.get(args.key) ?? null
    throw new Error(`unexpected ${cmd}`)
  }),
}))

import {
  headerSecretsKey,
  storeSecretHeaderValues,
  loadSecretHeaderValues,
  fillSecretHeaderValues,
  deleteSecretHeaderValues,
} from '../providerHeaderSecrets'

const SECRET = 'value-that-must-stay-secret'

describe('provider header secrets', () => {
  beforeEach(() => store.clear())

  it('keeps only the secret values, keyed apart from provider key chains', async () => {
    await storeSecretHeaderValues('custom', [
      { header: 'X-Tenant', value: 'acme' },
      { header: 'X-Key', value: ` ${SECRET} `, secret: true },
    ])
    expect(headerSecretsKey('custom')).not.toBe('custom')
    expect([...store.keys()]).toEqual([headerSecretsKey('custom')])
    const stored = store.get(headerSecretsKey('custom'))!
    expect(stored).not.toContain('acme')
    expect(await loadSecretHeaderValues('custom')).toEqual({ 'x-key': SECRET })
  })

  it('removes the entry once no header is secret', async () => {
    await storeSecretHeaderValues('custom', [
      { header: 'X-Key', value: SECRET, secret: true },
    ])
    await storeSecretHeaderValues('custom', [{ header: 'X-Key', value: 'plain' }])
    expect(store.size).toBe(0)
  })

  it('fills blank secret rows from the store, matching names by case', () => {
    expect(
      fillSecretHeaderValues(
        [
          { header: 'X-Tenant', value: 'acme' },
          { header: 'x-KEY', value: '', secret: true },
          { header: 'X-Other', value: '', secret: true },
        ],
        { 'x-key': SECRET }
      )
    ).toEqual([
      { header: 'X-Tenant', value: 'acme' },
      { header: 'x-KEY', value: SECRET, secret: true },
      { header: 'X-Other', value: '', secret: true },
    ])
  })

  it('reads nothing from an entry that is not a map of strings', async () => {
    store.set(headerSecretsKey('custom'), 'not json')
    expect(await loadSecretHeaderValues('custom')).toEqual({})
    store.set(headerSecretsKey('custom'), JSON.stringify({ a: 1 }))
    expect(await loadSecretHeaderValues('custom')).toEqual({})
  })

  it('deletes the entry with the provider', async () => {
    await storeSecretHeaderValues('custom', [
      { header: 'X-Key', value: SECRET, secret: true },
    ])
    await deleteSecretHeaderValues('custom')
    expect(store.size).toBe(0)
  })
})
