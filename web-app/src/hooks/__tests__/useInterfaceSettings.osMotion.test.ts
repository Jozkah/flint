import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { settingInterface: 'setting-appearance' },
}))
vi.mock('../useTheme', () => ({
  useTheme: { getState: vi.fn(() => ({ isDark: false })), setState: vi.fn(), subscribe: vi.fn(), destroy: vi.fn() },
}))
vi.mock('zustand/middleware', () => ({
  persist: (fn: unknown) => fn,
  createJSONStorage: () => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }),
}))
Object.defineProperty(global, 'IS_WINDOWS', { value: false, writable: true })
Object.defineProperty(global, 'IS_LINUX', { value: false, writable: true })
Object.defineProperty(global, 'IS_MACOS', { value: false, writable: true })
Object.defineProperty(global, 'IS_TAURI', { value: false, writable: true })

describe('reduce motion default', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  const load = async (matches: boolean) => {
    vi.resetModules()
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: matches && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }))
    const mod = await import('../useInterfaceSettings')
    return mod.useInterfaceSettings.getState().reduceMotion
  }

  it('starts on when the OS asks for reduced motion', async () => {
    expect(await load(true)).toBe(true)
  })

  it('starts off otherwise', async () => {
    expect(await load(false)).toBe(false)
  })
})

describe('reduce motion follows the OS while the app is open', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  const boot = async (initial: boolean) => {
    vi.resetModules()
    let os = initial
    let listener: (() => void) | undefined
    vi.stubGlobal('matchMedia', (q: string) => ({
      get matches() {
        return os && q.includes('reduce')
      },
      media: q,
      addEventListener: (_: string, l: () => void) => {
        listener = l
      },
      removeEventListener() {},
    }))
    const mod = await import('../useInterfaceSettings')
    return {
      store: mod.useInterfaceSettings,
      flip(next: boolean) {
        os = next
        listener?.()
      },
    }
  }

  it('turns on when the OS switch turns on and the user never changed it', async () => {
    const { store, flip } = await boot(false)
    flip(true)
    expect(store.getState().reduceMotion).toBe(true)
    flip(false)
    expect(store.getState().reduceMotion).toBe(false)
  })

  it('leaves a choice the user made by hand', async () => {
    const { store, flip } = await boot(false)
    store.getState().setReduceMotion(true)
    flip(true)
    flip(false)
    expect(store.getState().reduceMotion).toBe(true)
  })
})
