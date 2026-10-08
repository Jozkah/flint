import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    core: () => ({ convertFileSrc: (p: string) => `asset://${p}` }),
  }),
}))

import { ensureAssetAccess, toAssetUrl, resetAssetAccessCache } from '../assetPath'

const setTauri = (v: boolean) =>
  Object.defineProperty(globalThis, 'IS_TAURI', { value: v, writable: true, configurable: true })

describe('assetPath', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    resetAssetAccessCache()
    setTauri(true)
  })
  afterEach(() => setTauri(false))

  it('grants once per path then converts', async () => {
    expect(await toAssetUrl('D:\pics\a.png')).toBe('asset://D:\pics\a.png')
    await toAssetUrl('D:\pics\a.png')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('allow_asset_path', {
      path: 'D:\pics\a.png',
      recursive: false,
    })
  })

  it('memoizes concurrent requests', async () => {
    await Promise.all([ensureAssetAccess('/x'), ensureAssetAccess('/x')])
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('still returns a URL when the grant is refused, without retrying', async () => {
    invoke.mockRejectedValue('refusing to expose a filesystem root')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await toAssetUrl('/')).toBe('asset:///')
    await toAssetUrl('/')
    expect(invoke).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('skips the grant outside Tauri', async () => {
    setTauri(false)
    expect(await toAssetUrl('/y')).toBe('asset:///y')
    expect(invoke).not.toHaveBeenCalled()
  })
})
