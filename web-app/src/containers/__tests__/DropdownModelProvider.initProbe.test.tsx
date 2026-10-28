/**
 * The initializer probes a llama.cpp model's mmproj once, not on every
 * providers write, and stops when the picker unmounts mid-probe.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import '@testing-library/jest-dom'
const h = vi.hoisted(() => ({
  probe: vi.fn(() => Promise.resolve()),
}))

import DropdownModelProvider from '../DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'

vi.mock('@/hooks/useThreads', () => ({
  useThreads: vi.fn(() => ({ updateCurrentThreadModel: vi.fn() })),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: vi.fn(() => ({
    models: () => ({
      checkMmprojExists: vi.fn(() => Promise.resolve(false)),
      checkMmprojExistsAndUpdateOffloadMMprojSetting: h.probe,
    }),
  })),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: vi.fn(() => ({ t: (key: string) => key })),
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(() => vi.fn()),
}))
vi.mock('@/hooks/useFavoriteModel', () => ({
  useFavoriteModel: vi.fn(() => ({ favoriteModels: [] })),
}))
vi.mock('@/lib/platform/const', () => ({
  PlatformFeatures: {
    WEB_AUTO_MODEL_SELECTION: false,
    MODEL_PROVIDER_SETTINGS: true,
    projects: true,
  },
}))
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock('../ProvidersAvatar', () => ({ default: () => <div /> }))
vi.mock('../Capabilities', () => ({ default: () => <div /> }))
vi.mock('../ModelSetting', () => ({ ModelSetting: () => <div /> }))
vi.mock('../ModelSupportStatus', () => ({ ModelSupportStatus: () => <div /> }))


const MODEL = { id: 'local-a', capabilities: ['completion'], settings: {} }
const llama = (models: (typeof MODEL)[]) =>
  ({ provider: 'llamacpp', active: true, models, settings: [] }) as never
const flush = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

afterEach(() => {
  cleanup()
  h.probe.mockClear()
  useModelProvider.setState({ selectedModel: null, selectedProvider: '' })
})

describe('the model initializer probes', () => {
  it('probes a thread model once however often the providers change', async () => {
    useModelProvider.setState({ providers: [llama([MODEL])] })
    render(
      <DropdownModelProvider
        model={{ provider: 'llamacpp', id: 'local-a' } as never}
      />
    )
    await flush()
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        useModelProvider.setState({
          providers: [llama([{ ...MODEL, capabilities: [`c${i}`] }])],
        })
      })
      await flush()
    }
    expect(h.probe).toHaveBeenCalledTimes(1)
  })

  it('does not clear the global selection after it unmounts mid-probe', async () => {
    let release!: () => void
    h.probe.mockImplementationOnce(
      () => new Promise<void>((r) => (release = r))
    )
    useModelProvider.setState({
      providers: [llama([MODEL])],
      selectedProvider: 'llamacpp',
      selectedModel: MODEL as never,
    })
    const { unmount } = render(
      <DropdownModelProvider
        model={{ provider: 'llamacpp', id: 'local-a' } as never}
      />
    )
    await flush()
    unmount()
    release()
    await flush()
    expect(useModelProvider.getState().selectedModel?.id).toBe('local-a')
  })
})
