// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const tauriInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => tauriInvoke(...a), Channel: class {} }))

const { enableServerTransport } = await import('@/lib/providerFetch')
const { hostInvoke } = await import('@/lib/hostInvoke')

afterEach(() => vi.unstubAllGlobals())

const ok = (status = 204, json?: unknown) => ({ ok: true, status, redirected: false, json: async () => json })

describe('hostInvoke through the Flint server', () => {
  it('reads and writes provider keys on the server', async () => {
    enableServerTransport()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(ok(200, { keys: ['k1', 'k2'] }))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
    vi.stubGlobal('fetch', fetch)

    expect(await hostInvoke('get_provider_keys', { provider: 'open ai' })).toEqual(['k1', 'k2'])
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/provider-keys/open%20ai')

    await hostInvoke('register_provider_config', {
      request: {
        provider: 'openai',
        api_key: 'a',
        api_keys: ['b', ' '],
        custom_headers: [{ value: 'hdr', secret: true }, { value: 'plain' }],
      },
    })
    expect(fetch.mock.calls[1][0]).toBe('/api/v1/secret-values')
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ values: ['hdr'] })
    expect(fetch.mock.calls[2][0]).toBe('/api/v1/provider-keys/openai')
    expect(fetch.mock.calls[2][1]).toMatchObject({ method: 'PUT' })
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ keys: ['a', 'b'] })

    await hostInvoke('delete_provider_keys', { provider: 'openai' })
    expect(fetch.mock.calls[3][1]).toMatchObject({ method: 'DELETE' })
    expect(tauriInvoke).not.toHaveBeenCalled()
  })

  it('answers key presence and backup export without the plain key route', async () => {
    enableServerTransport()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(ok(200, { has: true }))
      .mockResolvedValueOnce(ok(200, { keys: ['k1'] }))
    vi.stubGlobal('fetch', fetch)

    expect(await hostInvoke('has_provider_keys', { provider: 'openai' })).toBe(true)
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/provider-keys/openai/status')

    expect(
      await hostInvoke('export_provider_keys_for_backup', { provider: 'openai', confirm: true })
    ).toEqual(['k1'])
    expect(fetch.mock.calls[1][0]).toBe('/api/v1/provider-keys/openai/backup')
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'POST' })
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ confirm: true })
  })

  it('treats desktop-only registry commands as no-ops', async () => {
    enableServerTransport()
    vi.stubGlobal('fetch', vi.fn())
    await expect(hostInvoke('set_model_param_defaults', { defaults: {} })).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })
})
