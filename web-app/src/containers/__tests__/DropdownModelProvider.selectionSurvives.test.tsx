/**
 * The model picker's initializer must not clear a model the user selected.
 *
 * Found by tracing a Cowork send in the real WebView: the click reached the
 * composer, and the composer refused with "no selected model" -- while the
 * picker still showed the model. The initializer re-runs on every change to
 * `providers`, and whenever the selected model was momentarily missing from an
 * active provider's list it fell through to `selectModelProvider('', '')`.
 *
 * These use the real store rather than a mocked hook: the defect was an
 * interaction between the effect and the store, which a stub cannot have.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import '@testing-library/jest-dom'
import DropdownModelProvider from '../DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { localStorageKey } from '@/constants/localStorage'

vi.mock('@/hooks/useThreads', () => ({
  useThreads: vi.fn(() => ({ updateCurrentThreadModel: vi.fn() })),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: vi.fn(() => ({
    models: () => ({
      checkMmprojExists: vi.fn(() => Promise.resolve(false)),
      checkMmprojExistsAndUpdateOffloadMMprojSetting: vi.fn(() =>
        Promise.resolve()
      ),
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

const MODEL = {
  id: 'smoke-model',
  capabilities: ['completion', 'tools'],
  settings: {},
}

const provider = (models: (typeof MODEL)[]) =>
  ({
    provider: 'local-server',
    active: true,
    models,
    settings: [],
  }) as never

const flush = () => act(async () => {
  await Promise.resolve()
  await Promise.resolve()
})

beforeEach(() => {
  localStorage.setItem(
    localStorageKey.lastUsedModel,
    JSON.stringify({ provider: 'local-server', model: 'smoke-model' })
  )
})

afterEach(() => {
  cleanup()
  localStorage.removeItem(localStorageKey.lastUsedModel)
  useModelProvider.setState({ selectedModel: null, selectedProvider: '' })
})

describe('the model initializer', () => {
  /// The regression. A providers change in which the selected model is
  /// momentarily absent -- a list refreshing, a probe writing back -- must not
  /// empty the selection the composer reads.
  it('keeps a selected model when the provider list briefly loses it', async () => {
    useModelProvider.setState({
      providers: [provider([MODEL])],
      selectedProvider: 'local-server',
      selectedModel: MODEL as never,
    })
    render(<DropdownModelProvider useLastUsedModel />)
    await flush()

    await act(async () => {
      useModelProvider.setState({ providers: [provider([])] })
    })
    await flush()

    expect(useModelProvider.getState().selectedModel?.id).toBe('smoke-model')
  })

  /// Initialising still initialises: with nothing selected, the last-used
  /// model is picked up.
  it('selects the last-used model when nothing is selected', async () => {
    useModelProvider.setState({
      providers: [provider([MODEL])],
      selectedProvider: '',
      selectedModel: null,
    })
    render(<DropdownModelProvider useLastUsedModel />)
    await flush()

    expect(useModelProvider.getState().selectedModel?.id).toBe('smoke-model')
  })

  /// janhq/jan#7703: a first run has no last-used model; the first local
  /// llama.cpp model is picked, which the home screen now asks for.
  it('falls back to the first local model on a first run', async () => {
    localStorage.removeItem(localStorageKey.lastUsedModel)
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp',
          active: true,
          models: [{ ...MODEL, id: 'first-local' }],
          settings: [],
        } as never,
      ],
      selectedProvider: '',
      selectedModel: null,
    })
    render(<DropdownModelProvider useLastUsedModel />)
    await flush()

    expect(useModelProvider.getState().selectedModel?.id).toBe('first-local')
  })
})
