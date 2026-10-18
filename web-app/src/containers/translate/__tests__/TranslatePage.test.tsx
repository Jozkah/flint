import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'

const streamText = vi.fn()
const createModel = vi.fn()
let state: Record<string, unknown> = {}

vi.mock('ai', () => ({ streamText: (...a: unknown[]) => streamText(...a) }))
vi.mock('@/lib/model-factory', () => ({
  ModelFactory: { createModel: (...a: unknown[]) => createModel(...a) },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(state),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}|${Object.values(vars).join('|')}` : key,
  }),
}))
const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/containers/DropdownModelProvider', () => ({
  default: () => <div data-testid="model-dropdown" />,
}))
// A native select keeps the language choice direct; the real picker has its
// own test.
vi.mock('../LanguagePicker', () => ({
  LanguagePicker: ({
    value,
    onChange,
    allowAuto,
    'aria-label': label,
    'data-testid': id,
  }: {
    'value': string
    'onChange': (v: string) => void
    'allowAuto'?: boolean
    'aria-label': string
    'data-testid': string
  }) => (
    <select
      value={value}
      aria-label={label}
      data-testid={id}
      onChange={(e) => onChange(e.target.value)}
    >
      {allowAuto && <option value="auto">auto</option>}
      <option value="English">English</option>
      <option value="Spanish">Spanish</option>
    </select>
  ),
}))

import { TranslatePage } from '../TranslatePage'

const provider = { provider: 'p', models: [{ id: 'm1' }] }

function streamOf(...chunks: string[]) {
  return {
    textStream: (async function* () {
      for (const c of chunks) yield c
    })(),
  }
}

beforeEach(() => {
  streamText.mockReset()
  navigate.mockReset()
  createModel.mockReset()
  createModel.mockResolvedValue({})
  state = {
    selectedModel: { id: 'm1', displayName: 'My Model' },
    selectedProvider: 'p',
    getProviderByName: () => provider,
  }
})

describe('TranslatePage', () => {
  it('turns spellcheck off on both panes', () => {
    render(<TranslatePage />)
    expect(screen.getByTestId('translate-input')).toHaveAttribute(
      'spellcheck',
      'false'
    )
    expect(screen.getByTestId('translate-output')).toHaveAttribute(
      'spellcheck',
      'false'
    )
  })

  it('renders both panes, language pickers and the model', () => {
    render(<TranslatePage />)
    expect(screen.getByTestId('translate-source-pane')).toBeInTheDocument()
    expect(screen.getByTestId('translate-target-pane')).toBeInTheDocument()
    expect(screen.getByTestId('translate-source')).toBeInTheDocument()
    expect(screen.getByTestId('translate-target')).toBeInTheDocument()
    expect(screen.getByTestId('model-dropdown')).toBeInTheDocument()
  })

  it('disables run without input or without a model', () => {
    const { unmount } = render(<TranslatePage />)
    expect(screen.getByTestId('translate-run')).toBeDisabled()
    fireEvent.change(screen.getByTestId('translate-input'), {
      target: { value: 'hola' },
    })
    expect(screen.getByTestId('translate-run')).toBeEnabled()
    unmount()

    state.selectedModel = undefined
    render(<TranslatePage />)
    fireEvent.change(screen.getByTestId('translate-input'), {
      target: { value: 'hola' },
    })
    expect(screen.getByTestId('translate-run')).toBeDisabled()
  })

  it('runs on Ctrl+Enter and streams the output', async () => {
    streamText.mockReturnValue(streamOf('Hel', 'lo'))
    render(<TranslatePage />)
    const input = screen.getByTestId('translate-input')
    fireEvent.change(input, { target: { value: 'hola' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    await waitFor(() =>
      expect(screen.getByTestId('translate-output')).toHaveValue('Hello')
    )
    expect(streamText).toHaveBeenCalledTimes(1)
    expect(streamText.mock.calls[0][0].prompt).toContain('hola')
  })

  it('starts one translation for a double trigger fired before the page re-renders', async () => {
    streamText.mockReturnValue(streamOf('Hi'))
    render(<TranslatePage />)
    const input = screen.getByTestId('translate-input')
    fireEvent.change(input, { target: { value: 'hola' } })
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    })
    await waitFor(() =>
      expect(screen.getByTestId('translate-output')).toHaveValue('Hi')
    )
    expect(streamText).toHaveBeenCalledTimes(1)
  })

  it('swaps languages and content', async () => {
    streamText.mockReturnValue(streamOf('Hello'))
    render(<TranslatePage />)
    fireEvent.change(screen.getByTestId('translate-source'), {
      target: { value: 'Spanish' },
    })
    fireEvent.change(screen.getByTestId('translate-input'), {
      target: { value: 'hola' },
    })
    fireEvent.click(screen.getByTestId('translate-run'))
    await waitFor(() =>
      expect(screen.getByTestId('translate-output')).toHaveValue('Hello')
    )
    fireEvent.click(screen.getByTestId('translate-swap'))
    expect(screen.getByTestId('translate-source')).toHaveValue('English')
    expect(screen.getByTestId('translate-target')).toHaveValue('Spanish')
    expect(screen.getByTestId('translate-input')).toHaveValue('Hello')
    expect(screen.getByTestId('translate-output')).toHaveValue('hola')
  })

  it('stop aborts the running translation', async () => {
    let signal: AbortSignal | undefined
    streamText.mockImplementation((opts: { abortSignal: AbortSignal }) => {
      signal = opts.abortSignal
      return {
        textStream: (async function* () {
          yield 'par'
          await new Promise((_, reject) =>
            signal!.addEventListener('abort', () =>
              reject(new Error('aborted'))
            )
          )
        })(),
      }
    })
    render(<TranslatePage />)
    fireEvent.change(screen.getByTestId('translate-input'), {
      target: { value: 'hola' },
    })
    fireEvent.click(screen.getByTestId('translate-run'))
    const stop = await screen.findByTestId('translate-stop')
    fireEvent.click(stop)
    await waitFor(() => expect(signal?.aborted).toBe(true))
    await waitFor(() =>
      expect(screen.getByTestId('translate-run')).toBeInTheDocument()
    )
    expect(screen.queryByTestId('translate-error')).not.toBeInTheDocument()
  })

  it('copies the translation', async () => {
    streamText.mockReturnValue(streamOf('Hello'))
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<TranslatePage />)
    fireEvent.change(screen.getByTestId('translate-input'), {
      target: { value: 'hola' },
    })
    fireEvent.click(screen.getByTestId('translate-run'))
    await waitFor(() =>
      expect(screen.getByTestId('translate-copy')).toBeEnabled()
    )
    fireEvent.click(screen.getByTestId('translate-copy'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Hello'))
  })

  it('shows an inline error when the model fails', async () => {
    createModel.mockRejectedValue(new Error('boom'))
    render(<TranslatePage />)
    fireEvent.change(screen.getByTestId('translate-input'), {
      target: { value: 'hola' },
    })
    fireEvent.click(screen.getByTestId('translate-run'))
    expect(await screen.findByTestId('translate-error')).toHaveTextContent(
      'boom'
    )
  })
  const runWith = async (text = 'hola') => {
    render(<TranslatePage />)
    fireEvent.change(screen.getByTestId('translate-input'), {
      target: { value: text },
    })
    fireEvent.click(screen.getByTestId('translate-run'))
  }

  it('surfaces an error the stream swallowed (bad key, server down)', async () => {
    streamText.mockImplementation(
      (opts: { onError: (e: { error: unknown }) => void }) => ({
        textStream: (async function* () {
          opts.onError({ error: new Error('401 Incorrect API key') })
          // streamText ends the stream empty after reporting the error.
        })(),
      })
    )
    await runWith()
    expect(await screen.findByTestId('translate-error')).toHaveTextContent(
      '401 Incorrect API key'
    )
    expect(screen.getByText('common:translate.retry')).toBeInTheDocument()
  })

  it('reads the message out of a plain-object failure', async () => {
    createModel.mockRejectedValue({ message: 'model is not loaded' })
    await runWith()
    expect(await screen.findByTestId('translate-error')).toHaveTextContent(
      'model is not loaded'
    )
  })

  it('says translation failed when the model returns nothing at all', async () => {
    streamText.mockReturnValue(streamOf())
    await runWith()
    expect(await screen.findByTestId('translate-error')).toHaveTextContent(
      'common:translate.failed'
    )
  })

  it('maps a bad-key failure to a plain line with a settings link and raw details', async () => {
    createModel.mockRejectedValue(new Error('invalid x-api-key'))
    await runWith()
    const box = await screen.findByTestId('translate-error')
    expect(box).toHaveTextContent('common:translate.errorAuth')
    expect(box).toHaveTextContent('invalid x-api-key')
    fireEvent.click(screen.getByTestId('translate-error-settings'))
    expect(navigate).toHaveBeenCalledWith({ to: '/settings/providers' })
  })

  it('disables swap and clear while a translation is running', async () => {
    let release: () => void = () => {}
    streamText.mockReturnValue({
      textStream: (async function* () {
        yield 'Hel'
        await new Promise<void>((r) => (release = r))
        yield 'lo'
      })(),
    })
    render(<TranslatePage />)
    fireEvent.change(screen.getByTestId('translate-source'), {
      target: { value: 'Spanish' },
    })
    fireEvent.change(screen.getByTestId('translate-input'), {
      target: { value: 'hola' },
    })
    fireEvent.click(screen.getByTestId('translate-run'))
    await waitFor(() =>
      expect(screen.getByTestId('translate-output')).toHaveValue('Hel')
    )
    expect(screen.getByTestId('translate-swap')).toBeDisabled()
    expect(screen.getByTestId('translate-clear')).toBeDisabled()
    await act(async () => release())
    await waitFor(() =>
      expect(screen.getByTestId('translate-swap')).toBeEnabled()
    )
  })

  it('retry runs again and clears the error on success', async () => {
    createModel.mockRejectedValueOnce(new Error('boom'))
    await runWith()
    await screen.findByTestId('translate-error')
    streamText.mockReturnValue(streamOf('Hello'))
    fireEvent.click(screen.getByText('common:translate.retry'))
    await waitFor(() =>
      expect(screen.getByTestId('translate-output')).toHaveValue('Hello')
    )
    expect(screen.queryByTestId('translate-error')).not.toBeInTheDocument()
  })
})
