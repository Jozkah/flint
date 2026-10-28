import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = vi.hoisted(() => new Map<string, string>())
const setItem = vi.hoisted(() => vi.fn())

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      setItem(k, v)
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
  },
}))
vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { settingHardware: 'hw-key' },
}))

import { useHardware } from '../useHardware'

describe('useHardware persistence', () => {
  beforeEach(() => {
    store.clear()
    setItem.mockClear()
  })

  it('updateSystemUsage does not write to storage', async () => {
    await Promise.resolve()
    setItem.mockClear()
    useHardware.getState().updateSystemUsage({
      total_memory: 1,
      used_memory: 1,
      cpu: 1,
      total_swap: 0,
      used_swap: 0,
    } as never)
    await Promise.resolve()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('persists only hardwareData', () => {
    useHardware.getState().pausePolling()
    const raw = store.get('hw-key')
    const state = raw ? JSON.parse(raw).state : {}
    expect(state.pollingPaused).toBeUndefined()
    expect(state.systemUsage).toBeUndefined()
  })

  it('rehydrate ignores persisted transient values and keeps hardwareData', async () => {
    store.set(
      'hw-key',
      JSON.stringify({
        state: {
          pollingPaused: true,
          systemUsage: { cpu: 99 },
          hardwareData: { gpus: [{ uuid: 'g', activated: true }] },
        },
        version: 0,
      })
    )
    useHardware.setState({ pollingPaused: false })
    await useHardware.persist.rehydrate()
    expect(useHardware.getState().pollingPaused).toBe(false)
    expect(useHardware.getState().systemUsage.cpu).not.toBe(99)
    expect(useHardware.getState().hardwareData.gpus[0].activated).toBe(true)
  })

  it('setGpuLoading with an out-of-range index does not throw', () => {
    expect(() => useHardware.getState().setGpuLoading(5, true)).not.toThrow()
    expect(useHardware.getState().gpuLoading).toEqual({})
  })
})
