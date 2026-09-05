import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DialogEditModel } from '../EditModel'
import { useModelProvider } from '@/hooks/useModelProvider'

/**
 * Renaming a model through the dialog: what is accepted, what is refused, and
 * what actually gets written to the provider.
 */

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

// The dialog's own open/close is not what these tests are about, so the
// content is always rendered.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock('@/components/ui/switch', () => ({
  Switch: ({ onCheckedChange, checked, ...props }: any) => (
    <input type="checkbox" readOnly checked={!!checked} {...props} />
  ),
}))

/** A provider with one plain model and one already renamed. */
const provider = {
  provider: 'openai',
  active: true,
  models: [
    { id: 'gpt-5', capabilities: ['tools'] },
    { id: 'gpt-5-mini', displayName: 'Fast one', capabilities: [] },
  ],
  settings: [],
} as unknown as ModelProvider

const nameField = () => screen.getByRole('textbox') as HTMLInputElement
const saveButton = () => screen.getByText('Save Changes').closest('button')!
const type = (value: string) =>
  fireEvent.change(nameField(), { target: { value } })

/** The models `updateProvider` was last called with. */
const savedModels = (): Model[] =>
  (updateProvider.mock.calls.at(-1)?.[1] as ModelProvider).models

beforeEach(() => {
  cleanup()
  updateProvider.mockClear()
  vi.mocked(useModelProvider).mockReturnValue({
    updateProvider,
  } as unknown as ReturnType<typeof useModelProvider>)
})

describe('the name a model starts with', () => {
  it('is its custom name when it has one', () => {
    render(<DialogEditModel provider={provider} modelId="gpt-5-mini" />)
    expect(nameField().value).toBe('Fast one')
  })

  it('is its identifier when it has not been renamed', () => {
    render(<DialogEditModel provider={provider} modelId="gpt-5" />)
    expect(nameField().value).toBe('gpt-5')
  })

  it('cannot be saved until something changes', () => {
    render(<DialogEditModel provider={provider} modelId="gpt-5" />)
    expect(saveButton()).toBeDisabled()
  })
})

describe('names the dialog refuses', () => {
  it('refuses an empty one, and says why', () => {
    render(<DialogEditModel provider={provider} modelId="gpt-5" />)
    type('   ')
    expect(saveButton()).toBeDisabled()
    expect(
      screen.getByText('providers:editModel.displayNameEmpty')
    ).toBeInTheDocument()
    expect(nameField()).toHaveAttribute('aria-invalid', 'true')
  })

  it('refuses a name another model already uses, whatever the case', () => {
    render(<DialogEditModel provider={provider} modelId="gpt-5" />)
    type('FAST ONE')
    expect(saveButton()).toBeDisabled()
    expect(
      screen.getByText('providers:editModel.displayNameDuplicate')
    ).toBeInTheDocument()
  })

  it('refuses a name that impersonates another model’s identifier', () => {
    render(<DialogEditModel provider={provider} modelId="gpt-5" />)
    type('gpt-5-mini')
    expect(saveButton()).toBeDisabled()
    expect(
      screen.getByText('providers:editModel.displayNameDuplicate')
    ).toBeInTheDocument()
  })

  it('writes nothing while the name is unusable', async () => {
    render(<DialogEditModel provider={provider} modelId="gpt-5" />)
    type('')
    fireEvent.click(saveButton())
    fireEvent.keyDown(nameField(), { key: 'Enter' })
    await waitFor(() => expect(updateProvider).not.toHaveBeenCalled())
  })
})

describe('saving a rename', () => {
  it('stores the name against the model, trimmed', async () => {
    render(<DialogEditModel provider={provider} modelId="gpt-5" />)
    type('  Daily driver  ')
    expect(saveButton()).toBeEnabled()
    fireEvent.click(saveButton())

    await waitFor(() => expect(updateProvider).toHaveBeenCalled())
    expect(savedModels()[0]).toMatchObject({
      id: 'gpt-5',
      displayName: 'Daily driver',
    })
  })

  it('leaves the identifier alone, so requests still address the model', async () => {
    render(<DialogEditModel provider={provider} modelId="gpt-5" />)
    type('Daily driver')
    fireEvent.click(saveButton())

    await waitFor(() => expect(updateProvider).toHaveBeenCalled())
    expect(savedModels()[0].id).toBe('gpt-5')
    expect(updateProvider).toHaveBeenCalledWith('openai', expect.anything())
  })

  it('does not touch the provider’s other models', async () => {
    render(<DialogEditModel provider={provider} modelId="gpt-5" />)
    type('Daily driver')
    fireEvent.click(saveButton())

    await waitFor(() => expect(updateProvider).toHaveBeenCalled())
    expect(savedModels()[1]).toMatchObject({
      id: 'gpt-5-mini',
      displayName: 'Fast one',
    })
  })

  it('drops the override when the identifier is typed back in', async () => {
    // Not "renamed to its own id": the custom name is gone, and the model
    // follows whatever the provider calls it from then on.
    render(<DialogEditModel provider={provider} modelId="gpt-5-mini" />)
    type('gpt-5-mini')
    expect(saveButton()).toBeEnabled()
    fireEvent.click(saveButton())

    await waitFor(() => expect(updateProvider).toHaveBeenCalled())
    expect(savedModels()[1].displayName).toBeUndefined()
  })
})
