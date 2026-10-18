import { describe, it, expect, vi, beforeEach } from 'vitest'

const isPlatformTauri = vi.fn()
const invoke = vi.fn()

vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: () => isPlatformTauri(),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ core: () => ({ invoke }) }),
}))

import { backendStorage, backendReadFailures } from '../backendStorage'

describe('backendStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  describe('web fallback (no Tauri)', () => {
    beforeEach(() => isPlatformTauri.mockReturnValue(false))

    it('reads/writes/removes via localStorage without touching the backend', async () => {
      expect(await backendStorage.getItem('k')).toBeNull()
      await backendStorage.setItem('k', 'v')
      expect(localStorage.getItem('k')).toBe('v')
      expect(await backendStorage.getItem('k')).toBe('v')
      await backendStorage.removeItem('k')
      expect(await backendStorage.getItem('k')).toBeNull()
      expect(invoke).not.toHaveBeenCalled()
    })
  })

  describe('tauri backend', () => {
    beforeEach(() => isPlatformTauri.mockReturnValue(true))

    it('routes through settings_* commands', async () => {
      invoke.mockResolvedValueOnce('stored')
      expect(await backendStorage.getItem('theme')).toBe('stored')
      expect(invoke).toHaveBeenCalledWith('settings_get', { key: 'theme' })

      await backendStorage.setItem('theme', '"dark"')
      expect(invoke).toHaveBeenCalledWith('settings_set', {
        key: 'theme',
        value: '"dark"',
      })

      await backendStorage.removeItem('theme')
      expect(invoke).toHaveBeenCalledWith('settings_remove', { key: 'theme' })
    })

    it('maps a missing key (null/undefined) to null', async () => {
      invoke.mockResolvedValueOnce(null)
      expect(await backendStorage.getItem('missing')).toBeNull()
      invoke.mockResolvedValueOnce(undefined)
      expect(await backendStorage.getItem('missing')).toBeNull()
    })

    it('degrades to null on backend error rather than throwing', async () => {
      invoke.mockRejectedValueOnce(new Error('boom'))
      await expect(backendStorage.getItem('k')).resolves.toBeNull()
    })

    it('refuses to write a key it could not read, until a read succeeds', async () => {
      invoke.mockRejectedValueOnce(new Error('boom'))
      await backendStorage.getItem('guarded')
      expect(backendReadFailures()).toContain('guarded')
      invoke.mockClear()
      await backendStorage.setItem('guarded', 'defaults')
      expect(invoke).not.toHaveBeenCalled()
      invoke.mockResolvedValueOnce('saved')
      await backendStorage.getItem('guarded')
      expect(backendReadFailures()).not.toContain('guarded')
      await backendStorage.setItem('guarded', 'new')
      expect(invoke).toHaveBeenCalledWith('settings_set', { key: 'guarded', value: 'new' })
    })

    it('swallows write errors so persistence never crashes the store', async () => {
      invoke.mockRejectedValueOnce(new Error('boom'))
      await expect(backendStorage.setItem('kw', 'v')).resolves.toBeUndefined()
    })

    it('skips the invoke when the same value is written again', async () => {
      invoke.mockResolvedValue(undefined)
      await backendStorage.setItem('dedup', 'v1')
      await backendStorage.setItem('dedup', 'v1')
      await backendStorage.setItem('dedup', 'v2')
      const sets = invoke.mock.calls.filter(([cmd]) => cmd === 'settings_set')
      expect(sets).toHaveLength(2)
      expect(sets.map(([, a]) => a.value)).toEqual(['v1', 'v2'])
    })

    it('a quick A -> B -> A leaves A on the backend (the second A is not skipped)', async () => {
      const calls: string[] = []
      let release: (() => void) | undefined
      invoke.mockImplementation(async (cmd: string, args: { value?: string }) => {
        if (cmd !== 'settings_set') return undefined
        calls.push(args.value as string)
        // Each write takes a moment, as the IPC round trip does.
        await new Promise<void>((r) => {
          release = r
          setTimeout(r, 5)
        })
        void release
      })
      await backendStorage.setItem('race', 'A')
      const b = backendStorage.setItem('race', 'B')
      const a2 = backendStorage.setItem('race', 'A')
      await Promise.all([b, a2])
      expect(calls).toEqual(['A', 'B', 'A'])
    })

    it('writes of one key reach the backend in the order they were requested', async () => {
      const seen: string[] = []
      invoke.mockImplementation(async (cmd: string, args: { value?: string }) => {
        if (cmd !== 'settings_set') return undefined
        // The first write is slower than the later ones.
        await new Promise((r) => setTimeout(r, args.value === 'one' ? 20 : 1))
        seen.push(args.value as string)
      })
      await Promise.all([
        backendStorage.setItem('order', 'one'),
        backendStorage.setItem('order', 'two'),
        backendStorage.setItem('order', 'three'),
      ])
      expect(seen).toEqual(['one', 'two', 'three'])
    })

    it('an identical write while the first is still in flight is not sent twice', async () => {
      invoke.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
      await Promise.all([
        backendStorage.setItem('same', 'v'),
        backendStorage.setItem('same', 'v'),
      ])
      expect(invoke.mock.calls.filter(([c]) => c === 'settings_set')).toHaveLength(1)
    })

    it('retries after a failed write (cache not poisoned)', async () => {
      invoke.mockRejectedValueOnce(new Error('boom'))
      await backendStorage.setItem('retry', 'v')
      invoke.mockResolvedValueOnce(undefined)
      await backendStorage.setItem('retry', 'v')
      const sets = invoke.mock.calls.filter(([cmd]) => cmd === 'settings_set')
      expect(sets).toHaveLength(2)
    })

    it('removeItem clears the cache so an identical later write is not skipped', async () => {
      invoke.mockResolvedValue(undefined)
      await backendStorage.setItem('rm', 'v')
      await backendStorage.removeItem('rm')
      await backendStorage.setItem('rm', 'v')
      const sets = invoke.mock.calls.filter(([cmd]) => cmd === 'settings_set')
      expect(sets).toHaveLength(2)
    })
  })
})
