import { describe, it, expect, vi } from 'vitest'
import { useModelProvider } from '../useModelProvider'
import { modelSettings } from '@/lib/predefined'

vi.mock('@/lib/fileStorage', () => ({
  fileStorage: {
    getItem: vi.fn(() => Promise.resolve(null)),
    setItem: vi.fn(() => Promise.resolve()),
    removeItem: vi.fn(() => Promise.resolve()),
  },
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: vi.fn(() => ({ path: () => ({ sep: () => '/' }) })),
}))

const migrate = (state: unknown, version: number) => {
  const persistApi = (useModelProvider as any).persist
  return persistApi.getOptions().migrate(state, version)
}

const llamacpp = (ctx: unknown) => ({
  provider: 'llamacpp',
  active: true,
  settings: [],
  models: [
    {
      id: 'qwen3-0.6b',
      settings: {
        ctx_len: { key: 'ctx_len', controller_props: { value: ctx } },
      },
    },
  ],
})

const ctxOf = (state: any) =>
  state.providers[0].models[0].settings.ctx_len.controller_props.value

// C043/C045: every model carried its own 8192, so the provider's Default
// context size never applied to any of them.
describe('useModelProvider - per-model context size defaults to unset', () => {
  it('seeds new models with a blank Context Size', () => {
    expect(modelSettings.ctx_len.controller_props.value).toBe('')
  })

  it('clears the seeded 8192 so the Default context size applies', () => {
    const migrated = migrate({ providers: [llamacpp(8192)] }, 23)
    expect(ctxOf(migrated)).toBe('')
  })

  it('keeps a context the user chose', () => {
    const migrated = migrate({ providers: [llamacpp(32768)] }, 23)
    expect(ctxOf(migrated)).toBe(32768)
  })
})
