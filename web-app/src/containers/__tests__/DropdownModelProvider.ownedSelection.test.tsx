/**
 * A picker whose caller owns the choice (Cowork passes `onModelChange` and
 * records the model on its session) must not write that choice into the
 * global, persisted selection every ordinary chat reads (#215).
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
const COWORK = model('cowork-model')
// Stable references, as a stored session or thread model is.
const CHAT_REF = { provider: 'local-server', id: 'chat-model' }
const COWORK_REF = { provider: 'local-server', id: 'cowork-model' }

const seed = () =>
  useModelProvider.setState({
    providers: [
      {
        provider: 'local-server',
        active: true,
        models: [CHAT, COWORK],
        settings: [],
      } as never,
    ],
    selectedProvider: 'local-server',
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

describe('a picker that owns its selection', () => {
  it('leaves the global model alone when mounted with its own model', async () => {
    seed()
    render(
      <DropdownModelProvider
        model={COWORK_REF}
        onModelChange={vi.fn()}
      />
    )
    await flush()

    expect(useModelProvider.getState().selectedModel?.id).toBe('chat-model')
  })

  it('reports a pick to its caller without touching the global model', async () => {
    seed()
    const onModelChange = vi.fn()
    render(
      <DropdownModelProvider
        model={CHAT_REF}
        onModelChange={onModelChange}
      />
    )
    await flush()

    const rows = screen.getAllByText('cowork-model')
    fireEvent.click(rows[rows.length - 1])
    await flush()

    expect(onModelChange).toHaveBeenCalledWith({
      provider: 'local-server',
      id: 'cowork-model',
    })
    expect(useModelProvider.getState().selectedModel?.id).toBe('chat-model')
    expect(localStorage.getItem(localStorageKey.lastUsedModel)).toBeNull()
  })

  it('still drives the global model when no caller owns the choice', async () => {
    seed()
    render(
      <DropdownModelProvider
        model={COWORK_REF}
      />
    )
    await flush()

    expect(useModelProvider.getState().selectedModel?.id).toBe('cowork-model')
  })
})
