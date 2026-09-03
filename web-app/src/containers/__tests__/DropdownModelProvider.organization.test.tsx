import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import DropdownModelProvider from '../DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelOrder } from '@/hooks/useModelOrder'
import { DEFAULT_MODEL_SORT } from '@/lib/modelSort'

/**
 * How the model list is ordered and searched once models can be renamed.
 *
 * The names below are deliberately at odds with the identifiers underneath
 * them: a rename that does not move a model in the list, or that makes it
 * unfindable by the identifier it is still called by, has not really worked.
 */

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: vi.fn(),
}))

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
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-trigger">{children}</div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
}))

vi.mock('../ProvidersAvatar', () => ({
  default: () => <div data-testid="provider-avatar" />,
}))

vi.mock('../Capabilities', () => ({
  default: () => <div data-testid="capabilities" />,
}))

vi.mock('../ModelSetting', () => ({
  ModelSetting: () => <div data-testid="model-setting" />,
}))

vi.mock('../ModelSupportStatus', () => ({
  ModelSupportStatus: () => <div data-testid="model-support-status" />,
}))

/** One local provider, whose models sort differently by name than by id. */
const providers = [
  {
    provider: 'llamacpp',
    active: true,
    models: [
      { id: 'zzz-model.gguf', displayName: 'Aardvark', capabilities: [] },
      { id: 'aaa-model.gguf', displayName: 'Zebra', capabilities: [] },
      { id: 'mmm-model.gguf', capabilities: [] },
    ],
    settings: [],
  },
] as unknown as ModelProvider[]

/** Where each name appears in the rendered list, in document order. */
const order = (...names: string[]) => {
  const text = screen.getByTestId('popover-content').textContent ?? ''
  return names.map((name) => text.indexOf(name))
}

const searchFor = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText('common:searchModels'), {
    target: { value },
  })

/** Rows, by the name shown on them. */
const listed = () => {
  const text = screen.getByTestId('popover-content').textContent ?? ''
  return ['Aardvark', 'Zebra', 'mmm-model.gguf'].filter((name) =>
    text.includes(name)
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useModelOrder.setState({ sort: DEFAULT_MODEL_SORT, lastUsed: {} })
  vi.mocked(useModelProvider).mockReturnValue({
    providers,
    selectedProvider: 'llamacpp',
    selectedModel: providers[0].models[0],
    getProviderByName: vi.fn((name: string) =>
      providers.find((p) => p.provider === name)
    ),
    selectModelProvider: vi.fn(),
    getModelBy: vi.fn((id: string) =>
      providers[0].models.find((m) => m.id === id)
    ),
    updateProvider: vi.fn(),
  } as unknown as ReturnType<typeof useModelProvider>)
})

afterEach(() => cleanup())

describe('the order models are listed in', () => {
  it('is alphabetical by the name on screen, not the identifier', () => {
    render(<DropdownModelProvider />)

    // By identifier this would be aaa, mmm, zzz — the opposite of what the
    // names say.
    const [aardvark, mmm, zebra] = order(
      'Aardvark',
      'mmm-model.gguf',
      'Zebra'
    )
    expect(aardvark).toBeGreaterThan(-1)
    expect(aardvark).toBeLessThan(mmm)
    expect(mmm).toBeLessThan(zebra)
  })

  it('reverses when the user asks for Z–A', () => {
    useModelOrder.setState({ sort: 'name-desc' })
    render(<DropdownModelProvider />)

    const [zebra, mmm, aardvark] = order(
      'Zebra',
      'mmm-model.gguf',
      'Aardvark'
    )
    expect(zebra).toBeLessThan(mmm)
    expect(mmm).toBeLessThan(aardvark)
  })

  it('puts the most recently used model first when asked', () => {
    useModelOrder.setState({
      sort: 'recent',
      lastUsed: { 'llamacpp:aaa-model.gguf': 200 },
    })
    render(<DropdownModelProvider />)

    // 'Zebra' is last alphabetically and first by use.
    const [zebra, aardvark] = order('Zebra', 'Aardvark')
    expect(zebra).toBeLessThan(aardvark)
  })

  it('still lists every model, whichever order is chosen', () => {
    useModelOrder.setState({ sort: 'name-desc' })
    render(<DropdownModelProvider />)
    expect(listed()).toHaveLength(3)
  })

  it('offers the sort control alongside the search box', () => {
    render(<DropdownModelProvider />)
    expect(
      screen.getByRole('button', { name: 'common:sortModels' })
    ).toBeInTheDocument()
  })
})

describe('finding a renamed model', () => {
  it('finds it by the name the user gave it', () => {
    render(<DropdownModelProvider />)
    searchFor('Aardvark')
    expect(listed()).toEqual(['Aardvark'])
  })

  it('finds it by the identifier it is still called by', () => {
    // The whole point of keeping the identifier: someone who knows the model
    // as 'zzz-model.gguf' can still find it after it was renamed.
    render(<DropdownModelProvider />)
    searchFor('zzz-model')
    expect(listed()).toEqual(['Aardvark'])
  })

  it('finds an unrenamed model by its identifier', () => {
    render(<DropdownModelProvider />)
    searchFor('mmm')
    expect(listed()).toEqual(['mmm-model.gguf'])
  })

  it('shows the identifier beside a renamed model’s name', () => {
    render(<DropdownModelProvider />)
    const text = screen.getByTestId('popover-content').textContent ?? ''
    expect(text).toContain('zzz-model.gguf')
    expect(text).toContain('Aardvark')
  })

  it('says so when nothing matches', () => {
    render(<DropdownModelProvider />)
    searchFor('nothing-like-this')
    expect(listed()).toEqual([])
    expect(screen.getByText('common:noModelsFoundFor')).toBeInTheDocument()
  })
})
