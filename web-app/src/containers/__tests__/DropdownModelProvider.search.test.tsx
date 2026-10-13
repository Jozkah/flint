import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import DropdownModelProvider from '../DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'

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


const m = (id: string, displayName?: string) => ({
  id,
  name: id,
  displayName,
  capabilities: ['completion'],
  settings: {},
})
const MODELS = [
  m('gpt-4o'),
  m('gpt-4o-mini'),
  // g, p, t appear only scattered across the id.
  m('gemini-pro-turbo'),
  m('deploy-a1', 'GPT Team Deployment'),
  m('claude-sonnet', 'Claude Sonnet'),
]
const IDS = MODELS.map((x) => x.id)

beforeEach(() => {
  useModelProvider.setState({
    providers: [
      { provider: 'my-gateway', active: true, models: MODELS, settings: [] } as never,
    ],
    selectedProvider: 'my-gateway',
    selectedModel: null,
  })
})
afterEach(() => {
  cleanup()
  useModelProvider.setState({ selectedModel: null, selectedProvider: '' })
})

const search = (query: string) =>
  fireEvent.change(screen.getByPlaceholderText('common:searchModels'), {
    target: { value: query },
  })
const rowText = (id: string) =>
  (MODELS.find((x) => x.id === id)!.displayName ?? id)
const visible = () =>
  IDS.filter((id) => screen.queryAllByText(rowText(id)).length > 0)

describe('DropdownModelProvider model search', () => {
  it('lists every model for an empty query', () => {
    render(<DropdownModelProvider />)
    expect(visible()).toEqual(IDS)
  })

  it('matches substrings of name or id, not scattered letters', () => {
    render(<DropdownModelProvider />)
    search('gpt')
    expect(visible()).toEqual(['gpt-4o', 'gpt-4o-mini', 'deploy-a1'])
  })

  it('is case-insensitive', () => {
    render(<DropdownModelProvider />)
    search('GPT-4O')
    expect(visible()).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  it('requires every whitespace-separated term', () => {
    render(<DropdownModelProvider />)
    search('  gpt   mini ')
    expect(visible()).toEqual(['gpt-4o-mini'])
  })

  it('shows the empty state when nothing contains the query', () => {
    render(<DropdownModelProvider />)
    search('gpx')
    expect(visible()).toEqual([])
    expect(screen.getByText('common:noModelsFoundFor')).toBeInTheDocument()
  })
})
