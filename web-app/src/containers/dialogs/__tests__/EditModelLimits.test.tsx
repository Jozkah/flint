import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DialogEditModel } from '../EditModel'
import { useModelProvider } from '@/hooks/useModelProvider'

/** The per-model token limits and the models.dev fill. */

const lookupModelsDev = vi.fn()
vi.mock('@/lib/modelsDev', () => ({ lookupModelsDev: (...a: unknown[]) => lookupModelsDev(...a) }))

const updateProvider = vi.fn()

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: vi.fn(() => ({ t: (key: string) => key })),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock('@/components/ui/button', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock('@/components/ui/switch', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Switch: ({ onCheckedChange, checked, ...props }: any) => (
    <input type="checkbox" readOnly checked={!!checked} {...props} />
  ),
}))

const provider = {
  provider: 'openai',
  active: true,
  models: [
    { id: 'gpt-5.4:flex', capabilities: [] },
    { id: 'set', capabilities: [], contextWindow: 32000, maxOutputTokens: 4096 },
  ],
  settings: [],
} as unknown as ModelProvider

const field = (id: string) => document.getElementById(id) as HTMLInputElement
const save = () => screen.getByText('common:saveChanges').closest('button')!
const savedModel = (id: string): Model =>
  (updateProvider.mock.calls.at(-1)?.[1] as ModelProvider).models.find((m) => m.id === id)!

beforeEach(() => {
  cleanup()
  updateProvider.mockClear()
  lookupModelsDev.mockReset()
  vi.mocked(useModelProvider).mockReturnValue({
    updateProvider,
  } as unknown as ReturnType<typeof useModelProvider>)
})

describe('model token limits', () => {
  it('shows the stored limits', () => {
    render(<DialogEditModel provider={provider} modelId="set" />)
    expect(field('context-window').value).toBe('32000')
    expect(field('max-output-tokens').value).toBe('4096')
  })

  it('saves typed limits on the model', async () => {
    render(<DialogEditModel provider={provider} modelId="set" />)
    fireEvent.change(field('max-output-tokens'), { target: { value: '8192' } })
    fireEvent.click(save())
    await waitFor(() => expect(updateProvider).toHaveBeenCalled())
    expect(savedModel('set')).toMatchObject({ contextWindow: 32000, maxOutputTokens: 8192 })
  })

  it('rejects a limit that is not a whole number above zero', () => {
    render(<DialogEditModel provider={provider} modelId="set" />)
    fireEvent.change(field('context-window'), { target: { value: '0' } })
    expect(save()).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('providers:editModel.limits.invalid')
  })

  it('fills from models.dev with the id as stored, marks the source and saves it', async () => {
    lookupModelsDev.mockResolvedValue({
      provider: 'openai',
      modelId: 'gpt-5.4',
      contextWindow: 1050000,
      maxOutputTokens: 128000,
    })
    render(<DialogEditModel provider={provider} modelId="gpt-5.4:flex" />)
    fireEvent.click(screen.getByText('providers:editModel.limits.lookUp').closest('button')!)
    await waitFor(() => expect(field('context-window').value).toBe('1050000'))
    expect(lookupModelsDev).toHaveBeenCalledWith('openai', 'gpt-5.4:flex')
    expect(field('max-output-tokens').value).toBe('128000')
    expect(screen.getByText('providers:editModel.limits.fromModelsDev')).toBeInTheDocument()
    fireEvent.click(save())
    await waitFor(() => expect(updateProvider).toHaveBeenCalled())
    expect(savedModel('gpt-5.4:flex')).toMatchObject({
      contextWindow: 1050000,
      maxOutputTokens: 128000,
      limitsSource: 'models.dev',
    })
  })

  it('drops the models.dev mark once the user overwrites a number', async () => {
    lookupModelsDev.mockResolvedValue({
      provider: 'openai', modelId: 'gpt-5.4', contextWindow: 1050000, maxOutputTokens: 128000,
    })
    render(<DialogEditModel provider={provider} modelId="gpt-5.4:flex" />)
    fireEvent.click(screen.getByText('providers:editModel.limits.lookUp').closest('button')!)
    await waitFor(() => expect(field('context-window').value).toBe('1050000'))
    fireEvent.change(field('context-window'), { target: { value: '200000' } })
    expect(screen.queryByText('providers:editModel.limits.fromModelsDev')).toBeNull()
  })

  it('says so when models.dev has no entry or cannot be reached', async () => {
    lookupModelsDev.mockResolvedValueOnce(null)
    render(<DialogEditModel provider={provider} modelId="set" />)
    const button = () => screen.getByText('providers:editModel.limits.lookUp').closest('button')!
    fireEvent.click(button())
    expect(await screen.findByText('providers:editModel.limits.notFound')).toBeInTheDocument()
    lookupModelsDev.mockRejectedValueOnce(new TypeError('offline'))
    fireEvent.click(button())
    expect(await screen.findByText('providers:editModel.limits.failed')).toBeInTheDocument()
    expect(field('context-window').value).toBe('32000')
  })
})
