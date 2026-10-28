import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }))
vi.mock('@/containers/dialogs/ImportLlamacppModelDialog', () => ({ ImportLlamacppModelDialog: () => <i data-testid="import-llama" /> }))
vi.mock('@/containers/dialogs/ImportMlxModelDialog', () => ({ ImportMlxModelDialog: () => <i data-testid="import-mlx" /> }))
vi.mock('@/containers/dialogs/AddModel', () => ({ DialogAddModel: () => <i data-testid="add-model" /> }))
vi.mock('@/containers/dialogs/DeleteAllModels', () => ({
  DialogDeleteAllModels: ({ remote }: { remote?: boolean }) => <i data-testid={remote ? 'delete-all-remote' : 'delete-all'} />,
}))

import { ProviderModelsFrame } from '../ProviderModelsFrame'

const model = (id: string) => ({ id, capabilities: [] }) as never

const props = (over: Record<string, unknown> = {}) =>
  ({
    provider: { provider: 'openai', models: [model('a'), model('b')] },
    isEngineProvider: false,
    handleRefreshModels: vi.fn(async () => {}),
    refreshingModels: false,
    handleModelImportSuccess: vi.fn(async () => {}),
    canFilterModels: false,
    modelQuery: '',
    setModelQuery: vi.fn(),
    allModels: [model('a'), model('b')],
    filteredModels: [model('a'), model('b')],
    isLlamacpp: false,
    embeddingModels: [],
    chatModels: [],
    sectionDivider: (label: string) => <hr aria-label={label} />,
    modelEntries: [
      { kind: 'model', model: model('a') },
      { kind: 'model', model: model('b') },
    ],
    toggleGroup: vi.fn(),
    providerName: 'openai',
    activeModels: [],
    renderModelRow: (m: { id: string }, key: string) => <li key={key} data-testid={`row-${m.id}`} />,
    handleStopModel: vi.fn(),
    loadingModels: [],
    handleStartModel: vi.fn(),
    localFiles: {},
    handleRevealModelFile: vi.fn(),
    defaultEmbeddingModelId: undefined,
    setDefaultEmbeddingModel: vi.fn(),
    modelLimit: 12,
    setModelLimit: vi.fn(),
    importingModel: null,
    ...over,
  }) as never

describe('ProviderModelsFrame', () => {
  it('renders one row per model entry', () => {
    render(<ProviderModelsFrame {...(props() as any)} />) // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(screen.getByTestId('row-a')).toBeTruthy()
    expect(screen.getByTestId('row-b')).toBeTruthy()
  })

  it('refreshes remote models, and disables the button while refreshing', async () => {
    const p: any = props() // eslint-disable-line @typescript-eslint/no-explicit-any
    const { rerender } = render(<ProviderModelsFrame {...p} />)
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(p.handleRefreshModels).toHaveBeenCalledTimes(1)
    rerender(<ProviderModelsFrame {...p} refreshingModels />)
    expect((screen.getByTitle('Refresh') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows no refresh button for an engine provider', () => {
    render(
      <ProviderModelsFrame
        {...(props({ isEngineProvider: true, provider: { provider: 'llamacpp', models: [model('a')] } }) as any)} // eslint-disable-line @typescript-eslint/no-explicit-any
      />
    )
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
  })

  it('filters: shows the box and a no-match line when the query matches nothing', async () => {
    const p: any = props({ canFilterModels: true, modelQuery: 'zzz', filteredModels: [] }) // eslint-disable-line @typescript-eslint/no-explicit-any
    render(<ProviderModelsFrame {...p} />)
    expect(screen.getByTestId('models-no-match').textContent).toContain('zzz')
    await userEvent.type(screen.getByRole('textbox'), 'a')
    expect(p.setModelQuery).toHaveBeenCalled()
  })

  it('shows a progress line while a model imports', () => {
    render(<ProviderModelsFrame {...(props({ importingModel: 'big.gguf' }) as any)} />) // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(screen.getByText(/big\.gguf/)).toBeTruthy()
  })
})
