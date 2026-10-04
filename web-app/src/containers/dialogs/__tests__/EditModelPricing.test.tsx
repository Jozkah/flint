import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DialogEditModel } from '../EditModel'
import { useModelProvider } from '@/hooks/useModelProvider'

/** The per-model price fields, including the optional cache prices. */

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
  provider: 'anthropic',
  active: true,
  models: [
    {
      id: 'priced',
      capabilities: [],
      inputCostPerMillion: 3,
      outputCostPerMillion: 15,
      cachedInputCostPerMillion: 0.3,
      cacheWriteCostPerMillion: 3.75,
    },
    { id: 'plain', capabilities: [] },
  ],
  settings: [],
} as unknown as ModelProvider

const field = (id: string) => document.getElementById(id) as HTMLInputElement
const save = () => screen.getByText('Save Changes').closest('button')!
const savedModel = (id: string): Model =>
  (updateProvider.mock.calls.at(-1)?.[1] as ModelProvider).models.find((m) => m.id === id)!

beforeEach(() => {
  cleanup()
  updateProvider.mockClear()
  vi.mocked(useModelProvider).mockReturnValue({
    updateProvider,
  } as unknown as ReturnType<typeof useModelProvider>)
})

describe('model price fields', () => {
  it('shows the four prices a model has', () => {
    render(<DialogEditModel provider={provider} modelId="priced" />)
    expect(field('input-cost').value).toBe('3')
    expect(field('output-cost').value).toBe('15')
    expect(field('cached-input-cost').value).toBe('0.3')
    expect(field('cache-write-cost').value).toBe('3.75')
  })

  it('leaves the cache prices blank for a model without them', () => {
    render(<DialogEditModel provider={provider} modelId="plain" />)
    expect(field('cached-input-cost').value).toBe('')
    expect(field('cache-write-cost').value).toBe('')
    expect(save()).toBeDisabled()
  })

  it('saves the cache prices beside input and output', async () => {
    render(<DialogEditModel provider={provider} modelId="plain" />)
    fireEvent.change(field('input-cost'), { target: { value: '2' } })
    fireEvent.change(field('cached-input-cost'), { target: { value: '0.5' } })
    fireEvent.change(field('cache-write-cost'), { target: { value: '2.5' } })
    fireEvent.click(save())
    await waitFor(() => expect(updateProvider).toHaveBeenCalled())
    const m = savedModel('plain')
    expect(m.inputCostPerMillion).toBe(2)
    expect(m.cachedInputCostPerMillion).toBe(0.5)
    expect(m.cacheWriteCostPerMillion).toBe(2.5)
  })

  it('saves a cleared cache price as unset, so it falls back to the input price', async () => {
    render(<DialogEditModel provider={provider} modelId="priced" />)
    fireEvent.change(field('cached-input-cost'), { target: { value: '' } })
    fireEvent.click(save())
    await waitFor(() => expect(updateProvider).toHaveBeenCalled())
    const m = savedModel('priced')
    expect(m.cachedInputCostPerMillion).toBeUndefined()
    expect(m.cacheWriteCostPerMillion).toBe(3.75)
  })

  it('refuses a negative or non-numeric cache price', () => {
    render(<DialogEditModel provider={provider} modelId="plain" />)
    fireEvent.change(field('cache-write-cost'), { target: { value: '-1' } })
    expect(field('cache-write-cost')).toHaveAttribute('aria-invalid', 'true')
    expect(save()).toBeDisabled()
  })
})
