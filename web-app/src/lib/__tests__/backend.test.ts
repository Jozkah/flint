// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const tauriInvoke = vi.fn(async () => 'tauri')
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => tauriInvoke(...(a as [])),
  Channel: class {},
}))

const providerFetch = await import('@/lib/providerFetch')
const { invokeCommand, hasRestRoute } = await import('@/lib/backend')

type W = typeof globalThis & {
  __FLINT_PREVIEW_INVOKE__?: unknown
  __TAURI_INTERNALS__?: unknown
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  tauriInvoke.mockClear()
  delete w.__FLINT_PREVIEW_INVOKE__
  delete w.__TAURI_INTERNALS__
})

const w = globalThis as W

describe('invokeCommand routing', () => {
  it('asks the dev preview seed first', async () => {
    w.__FLINT_PREVIEW_INVOKE__ = (cmd: string) =>
      cmd === 'list_skills' ? Promise.resolve(['seeded']) : undefined
    expect(await invokeCommand('list_skills')).toEqual(['seeded'])
    expect(tauriInvoke).not.toHaveBeenCalled()
  })

  it('falls through to Tauri when the preview passes', async () => {
    w.__FLINT_PREVIEW_INVOKE__ = () => undefined
    expect(await invokeCommand('list_skills', { a: 1 })).toBe('tauri')
    expect(tauriInvoke).toHaveBeenCalledWith('list_skills', { a: 1 })
  })

  it('uses Tauri when the runtime is present, even with server transport', async () => {
    vi.spyOn(providerFetch, 'hasTauriRuntime').mockReturnValue(true)
    vi.spyOn(providerFetch, 'hasProviderTransport').mockReturnValue(true)
    expect(await invokeCommand('get_provider_keys', { provider: 'x' })).toBe('tauri')
  })

  it('routes a mapped command to the Flint server in the browser', async () => {
    vi.spyOn(providerFetch, 'hasTauriRuntime').mockReturnValue(false)
    vi.spyOn(providerFetch, 'hasProviderTransport').mockReturnValue(true)
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      redirected: false,
      json: async () => ({ has: true }),
    }))
    vi.stubGlobal('fetch', fetch)
    expect(await invokeCommand('has_provider_keys', { provider: 'p' })).toBe(true)
    expect(tauriInvoke).not.toHaveBeenCalled()
  })

  it('sends an unmapped command to Tauri in the browser (the server RPC route)', async () => {
    vi.spyOn(providerFetch, 'hasTauriRuntime').mockReturnValue(false)
    vi.spyOn(providerFetch, 'hasProviderTransport').mockReturnValue(true)
    expect(await invokeCommand('list_skills')).toBe('tauri')
    expect(tauriInvoke).toHaveBeenCalledWith('list_skills')
  })

  it('forwards a call with no arguments without an undefined argument', async () => {
    await invokeCommand('migration_detect')
    expect(tauriInvoke.mock.calls[0]).toEqual(['migration_detect'])
  })

  it('knows only its own REST routes', () => {
    expect(hasRestRoute('get_provider_keys')).toBe(true)
    expect(hasRestRoute('constructor')).toBe(false)
    expect(hasRestRoute('list_skills')).toBe(false)
  })
})
