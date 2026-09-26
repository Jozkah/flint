/**
 * A chat or Cowork session keeps its model after that model's provider is
 * removed. The picker must name the model as unavailable: not crash, and not
 * silently show or select another model.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import DropdownModelProvider from '../DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { localStorageKey } from '@/constants/localStorage'

// Stable across renders, as the real store's actions are.
const threadsApi = {
  updateCurrentThreadModel: vi.fn(),
  updateThreadModel: vi.fn(),
  threads: {},
}
vi.mock('@/hooks/useThreads', () => ({
  useThreads: vi.fn(() => threadsApi),
}))
const serviceHub = {
  models: () => ({
    checkMmprojExists: vi.fn(() => Promise.resolve(false)),
    checkMmprojExistsAndUpdateOffloadMMprojSetting: vi.fn(() =>
      Promise.resolve()
    ),
  }),
}
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: vi.fn(() => serviceHub),
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

const model = (id: string) => ({
  id,
  name: id,
  capabilities: ['completion', 'tools'],
  settings: {},
})
const CHAT = model('chat-model')
const OTHER = model('other-model')
// A stable reference, as a stored thread or session model is.
const THREAD_REF = { provider: 'Qwen 3.8 500k (8081)', id: 'chat-model' }

const seed = () =>
  useModelProvider.setState({
    providers: [
      {
        provider: 'Qwen 3.8 500k (8081)',
        active: true,
        models: [CHAT],
        settings: [],
      } as never,
      {
        provider: 'openai',
        active: true,
        models: [OTHER],
        settings: [],
      } as never,
    ],
    selectedProvider: 'Qwen 3.8 500k (8081)',
    selectedModel: CHAT as never,
  })

const flush = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

afterEach(() => {
  cleanup()
  localStorage.removeItem(localStorageKey.lastUsedModel)
  useModelProvider.setState({ selectedModel: null, selectedProvider: '' })
})

describe('a chat or session whose provider was removed', () => {
  it('shows the chat model as unavailable without switching to another model', async () => {
    seed()
    render(<DropdownModelProvider model={THREAD_REF} />)
    await flush()
    expect(screen.queryByText('common:modelUnavailable')).toBeNull()

    act(() => {
      useModelProvider.getState().deleteProvider('Qwen 3.8 500k (8081)')
    })
    await flush()

    const label = screen.getAllByText('common:modelUnavailable')
    expect(label[0]).toHaveAttribute('data-unavailable')
    const state = useModelProvider.getState()
    expect(state.selectedModel).toBeNull()
    expect(state.selectedProvider).not.toBe('openai')
  })

  it('shows a Cowork session model as unavailable without reporting a new choice', async () => {
    seed()
    useModelProvider.getState().deleteProvider('Qwen 3.8 500k (8081)')
    const onModelChange = vi.fn()
    render(
      <DropdownModelProvider model={THREAD_REF} onModelChange={onModelChange} />
    )
    await flush()

    expect(screen.getAllByText('common:modelUnavailable').length).toBeGreaterThan(0)
    expect(onModelChange).not.toHaveBeenCalled()
  })
})

