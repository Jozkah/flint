import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DialogEditModel } from '../EditModel'
import { useModelProvider } from '@/hooks/useModelProvider'

/** The per-model API format: Automatic / Chat Completions / Responses. */

const updateProvider = vi.fn()

vi.mock('@/hooks/useModelProvider', () => ({ useModelProvider: vi.fn() }))
vi.mock('@/lib/modelsDev', () => ({ lookupModelsDev: vi.fn() }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: vi.fn(() => ({
    t: (key: string, o?: { format?: string }) => (o?.format ? `${key}:${o.format}` : key),
  })),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock('@/components/ui/input', () => ({ Input: (props: any) => <input {...props} /> }))
vi.mock('@/components/ui/button', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))
vi.mock('@/components/ui/switch', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Switch: ({ onCheckedChange, checked, ...props }: any) => (
    <input type="checkbox" readOnly checked={!!checked} {...props} />
  ),
}))
vi.mock('@/components/ui/select', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Select: ({ children, onChange, ...props }: any) => (
    <select onChange={onChange} {...props}>
      {children}
    </select>
  ),
}))

const make = (providerName: string, model: Record<string, unknown> = {}) =>
  ({
    provider: providerName,
    active: true,
    models: [{ id: 'm', capabilities: [], ...model }],
    settings: [],
  }) as unknown as ModelProvider

const select = () => document.getElementById('api-format') as HTMLSelectElement
const save = () => screen.getByText('common:saveChanges').closest('button')!
const saved = (): Model =>
  (updateProvider.mock.calls.at(-1)?.[1] as ModelProvider).models[0]!

beforeEach(() => {
  cleanup()
  updateProvider.mockClear()
  vi.mocked(useModelProvider).mockReturnValue({
    updateProvider,
  } as unknown as ReturnType<typeof useModelProvider>)
})

describe('API format control', () => {
  it('shows Automatic when nothing is stored', () => {
    render(<DialogEditModel provider={make('openai')} modelId="m" />)
    expect(select().value).toBe('auto')
    expect(screen.getByText('providers:editModel.apiFormat.help')).toBeInTheDocument()
  })

  it('saves a forced format on the model', async () => {
    render(<DialogEditModel provider={make('openai')} modelId="m" />)
    fireEvent.change(select(), { target: { value: 'responses' } })
    fireEvent.click(save())
    await waitFor(() => expect(updateProvider).toHaveBeenCalled())
    expect(saved().apiFormat).toBe('responses')
  })

  it('stores Automatic as no value', async () => {
    render(<DialogEditModel provider={make('openai', { apiFormat: 'chat' })} modelId="m" />)
    expect(select().value).toBe('chat')
    fireEvent.change(select(), { target: { value: 'auto' } })
    fireEvent.click(save())
    await waitFor(() => expect(updateProvider).toHaveBeenCalled())
    expect(saved().apiFormat).toBeUndefined()
  })

  it('shows the detected format and resets it', async () => {
    render(
      <DialogEditModel
        provider={make('kewaii', { detectedApiFormat: 'responses' })}
        modelId="m"
      />
    )
    expect(
      screen.getByText('providers:editModel.apiFormat.detected:providers:editModel.apiFormat.responses')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText('providers:editModel.apiFormat.reset'))
    expect(screen.queryByText('providers:editModel.apiFormat.reset')).toBeNull()
    fireEvent.click(save())
    await waitFor(() => expect(updateProvider).toHaveBeenCalled())
    expect(saved().detectedApiFormat).toBeUndefined()
  })

  it('is absent for providers with their own API', () => {
    render(<DialogEditModel provider={make('anthropic')} modelId="m" />)
    expect(select()).toBeNull()
  })
})
