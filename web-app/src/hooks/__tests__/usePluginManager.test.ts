import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) =>
      vars ? `${k}:${JSON.stringify(vars)}` : k,
  }),
}))

const mocks = vi.hoisted(() => ({
  listPlugins: vi.fn(),
  getPluginDetails: vi.fn(),
  getPluginSources: vi.fn(),
  setPluginEnabled: vi.fn(),
  removePlugin: vi.fn(),
  updatePlugin: vi.fn(),
  invalidateSkills: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn() },
}))

vi.mock('@/hooks/useSkills', () => ({
  invalidateSkills: () => mocks.invalidateSkills(),
}))

vi.mock('@/lib/pluginStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pluginStore')>()
  return {
    ...actual,
    listPlugins: (...a: unknown[]) => mocks.listPlugins(...a),
    getPluginDetails: (...a: unknown[]) => mocks.getPluginDetails(...a),
    getPluginSources: (...a: unknown[]) => mocks.getPluginSources(...a),
    setPluginEnabled: (...a: unknown[]) => mocks.setPluginEnabled(...a),
    removePlugin: (...a: unknown[]) => mocks.removePlugin(...a),
    updatePlugin: (...a: unknown[]) => mocks.updatePlugin(...a),
  }
})

import { usePluginManager } from '../usePluginManager'
import { PluginError, type InstalledPlugin } from '@/lib/pluginStore'

const alpha = {
  id: 'alpha',
  name: 'alpha',
  version: '1.0.0',
  enabled: false,
} as unknown as InstalledPlugin

const details = (over: Record<string, unknown> = {}) => ({
  ...alpha,
  description: '',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listPlugins.mockResolvedValue([alpha])
  mocks.getPluginSources.mockResolvedValue({ gitAvailable: true, marketplace: null })
  mocks.getPluginDetails.mockImplementation(async (_f: string, id: string) =>
    details({ id })
  )
})

describe('usePluginManager', () => {
  it('lists a project folder without a scope argument', async () => {
    const { result } = renderHook(() => usePluginManager({ scopeFolder: '/proj' }))
    await waitFor(() => expect(result.current.plugins).toEqual([alpha]))
    expect(mocks.listPlugins).toHaveBeenCalledWith('/proj')
  })

  it('lists the global store with an empty folder and the global scope', async () => {
    const { result } = renderHook(() =>
      usePluginManager({ scopeFolder: null, global: true })
    )
    await waitFor(() => expect(result.current.plugins).toEqual([alpha]))
    expect(mocks.listPlugins).toHaveBeenCalledWith('', 'global')
  })

  it('does nothing without a folder, and loads nothing while inactive', async () => {
    const { result } = renderHook(() => usePluginManager({ scopeFolder: null }))
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.plugins).toEqual([])
    renderHook(() => usePluginManager({ scopeFolder: '/proj', active: false }))
    expect(mocks.listPlugins).not.toHaveBeenCalled()
  })

  it('applies a toggle optimistically and keeps what the backend answers', async () => {
    let release: (v: { enabled: boolean }) => void = () => {}
    mocks.setPluginEnabled.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const { result } = renderHook(() => usePluginManager({ scopeFolder: '/proj' }))
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))

    let pending!: Promise<void>
    act(() => {
      pending = result.current.toggle(alpha, true)
    })
    expect(result.current.plugins[0].enabled).toBe(true)
    expect(result.current.toggling).toBe('alpha')

    await act(async () => {
      release({ enabled: true })
      await pending
    })
    expect(result.current.toggling).toBeNull()
    expect(mocks.setPluginEnabled).toHaveBeenCalledWith('/proj', 'alpha', true)
    expect(mocks.invalidateSkills).toHaveBeenCalled()
    expect(mocks.toastSuccess).toHaveBeenCalled()
  })

  it('reverts a failed toggle and says why', async () => {
    mocks.setPluginEnabled.mockRejectedValue(new PluginError('io', 'disk full'))
    const { result } = renderHook(() => usePluginManager({ scopeFolder: '/proj' }))
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))

    await act(async () => {
      await result.current.toggle(alpha, true)
    })
    expect(result.current.plugins[0].enabled).toBe(false)
    expect(result.current.toggleError).toContain('plugins:toggle.failed')
    expect(mocks.invalidateSkills).not.toHaveBeenCalled()
  })

  it('refreshes the list when a toggle finds the plugin already gone', async () => {
    mocks.setPluginEnabled.mockRejectedValue(new PluginError('not_installed', 'gone'))
    const { result } = renderHook(() => usePluginManager({ scopeFolder: '/proj' }))
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))
    expect(mocks.listPlugins).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.toggle(alpha, true)
    })
    await waitFor(() => expect(mocks.listPlugins).toHaveBeenCalledTimes(2))
  })

  it('selects a plugin and loads its details', async () => {
    const { result } = renderHook(() => usePluginManager({ scopeFolder: '/proj' }))
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))
    act(() => result.current.select('alpha'))
    await waitFor(() => expect(result.current.details?.id).toBe('alpha'))
    expect(result.current.selectedId).toBe('alpha')
  })

  it('confirms a removal, clears the selection and refreshes', async () => {
    mocks.removePlugin.mockResolvedValue({
      name: 'alpha',
      removedPath: '/x',
      removedSkillEntries: [],
      removedFromDisabled: false,
    })
    const { result } = renderHook(() => usePluginManager({ scopeFolder: '/proj' }))
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))
    act(() => result.current.select('alpha'))
    await waitFor(() => expect(result.current.details).not.toBeNull())

    act(() => result.current.setConfirmRemove(result.current.details))
    mocks.listPlugins.mockResolvedValue([])
    await act(async () => {
      await result.current.confirmRemoval()
    })
    expect(mocks.removePlugin).toHaveBeenCalledWith('/proj', 'alpha')
    expect(result.current.confirmRemove).toBeNull()
    expect(result.current.selectedId).toBeNull()
    expect(result.current.details).toBeNull()
    expect(result.current.plugins).toEqual([])
    expect(result.current.removing).toBe(false)
    expect(mocks.invalidateSkills).toHaveBeenCalled()
  })

  it('keeps the error and closes the confirm when a removal fails', async () => {
    mocks.removePlugin.mockRejectedValue(new PluginError('io', 'locked'))
    const { result } = renderHook(() => usePluginManager({ scopeFolder: '/proj' }))
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))
    act(() => result.current.setConfirmRemove(details() as never))
    await act(async () => {
      await result.current.confirmRemoval()
    })
    expect(result.current.removeError).toContain('plugins:remove.failed')
    expect(result.current.confirmRemove).toBeNull()
    // The directory may be gone even when the cleanup after it failed.
    expect(mocks.invalidateSkills).toHaveBeenCalled()
  })
})
