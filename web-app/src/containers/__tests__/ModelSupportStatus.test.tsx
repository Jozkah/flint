import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock-backed: the engine, the session lookup and the HTTP request are fakes.
// These tests prove the UI's state transitions and what it records, not that a
// real model loads on real hardware. Without a TranslationProvider `t` returns
// the key, so assertions name keys, as the other component tests here do.

const models = {
  fetchModels: vi.fn(),
  getActiveModels: vi.fn(),
  startModel: vi.fn(),
  stopModel: vi.fn(),
}

// One hub instance, as in the app: a new object per render would re-run every
// effect keyed on it.
const hub = { models: () => models }
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => hub,
  getServiceHub: () => hub,
}))

vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  findSessionByModel: vi.fn().mockResolvedValue({ port: 3900, api_key: 'k' }),
  readGgufMetadata: vi.fn().mockRejectedValue(new Error('no metadata in test')),
}))

const providerFetch = vi.fn()
vi.mock('@/lib/providerFetch', () => ({
  providerFetch: (...args: unknown[]) => providerFetch(...args),
}))

import { ModelSupportStatus } from '../ModelSupportStatus'
import { useHardware } from '@/hooks/useHardware'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelEvidence } from '@/hooks/useModelEvidence'
import { useAppState } from '@/hooks/useAppState'

const GIB = 1024 ** 3

function seed() {
  useHardware.setState({
    hardwareData: {
      cpu: { arch: 'x86_64', core_count: 8, extensions: [], name: 'CPU', usage: 0 },
      gpus: [],
      os_type: 'linux',
      os_name: 'Linux',
      total_memory: 32 * 1024,
    },
  })
  useModelProvider.setState({
    providers: [
      {
        provider: 'llamacpp',
        active: true,
        models: [
          {
            id: 'qwen3-8b',
            settings: { ctx_len: { controller_props: { value: 4096 } } },
          },
        ],
        settings: [{ key: 'models_max', controller_props: { value: 1 } }],
      },
    ] as unknown as ModelProvider[],
  })
  useModelEvidence.setState({ results: {}, preferredModel: null, dismissedHints: [] })
  useAppState.setState({ activeModels: [] })
  models.fetchModels.mockResolvedValue([
    { id: 'qwen3-8b', providerId: 'llamacpp', sizeBytes: 5 * GIB, path: '/m.gguf' },
    { id: 'busy', providerId: 'llamacpp', sizeBytes: 2 * GIB, path: '/b.gguf' },
  ])
  models.getActiveModels.mockResolvedValue([])
  models.startModel.mockResolvedValue(undefined)
  models.stopModel.mockResolvedValue({ success: true })
  providerFetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: 'ready' } }],
        timings: { predicted_per_second: 30 },
      }),
      { status: 200 }
    )
  )
}

const renderStatus = () =>
  render(<ModelSupportStatus modelId="qwen3-8b" provider="llamacpp" contextSize={4096} />)

async function openDetails() {
  const trigger = await screen.findByRole('button', { name: 'model-fit:triggerLabel' })
  await userEvent.click(trigger)
  return trigger
}

describe('ModelSupportStatus', () => {
  beforeEach(() => {
    seed()
  })

  it('renders nothing for a remote provider', () => {
    const { container } = render(
      <ModelSupportStatus modelId="gpt" provider="openai" contextSize={4096} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('separates the measured state from the estimate, and never blocks', async () => {
    renderStatus()
    await openDetails()
    expect(screen.getByText('model-fit:evidence.not-tested')).toBeInTheDocument()
    expect(screen.getByText('model-fit:verdict.fits')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'model-fit:test.run' })).toBeEnabled()
  })

  it('runs a real test sequence, records the result with its settings and releases the model', async () => {
    renderStatus()
    await openDetails()
    await userEvent.click(screen.getByRole('button', { name: 'model-fit:test.run' }))

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('model-fit:test.succeeded')
    )
    expect(models.startModel).toHaveBeenCalledTimes(1)
    expect(models.stopModel).toHaveBeenCalledWith('qwen3-8b', 'llamacpp')

    const [stored] = useModelEvidence.getState().results['llamacpp:qwen3-8b']
    expect(stored.outcome).toBe('success')
    expect(stored.conditions.settings).toEqual({ ctx_len: 4096 })
    expect(stored.metrics.generationTokensPerSecond).toBe(30)
    expect(
      await screen.findByText('model-fit:evidence.ran-successfully')
    ).toBeInTheDocument()
  })

  it('asks before unloading another model and does not load anything meanwhile', async () => {
    models.getActiveModels.mockResolvedValue(['busy'])
    renderStatus()
    await openDetails()
    await userEvent.click(screen.getByRole('button', { name: 'model-fit:test.run' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('model-fit:test.confirmUnload')
    expect(models.startModel).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'model-fit:test.dontTest' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(models.stopModel).not.toHaveBeenCalled()
  })

  it('records a failure as a failure of these settings, and offers a retry', async () => {
    models.startModel.mockRejectedValue({ code: 'OUT_OF_MEMORY', message: 'Not enough memory' })
    renderStatus()
    await openDetails()
    await userEvent.click(screen.getByRole('button', { name: 'model-fit:test.run' }))

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('model-fit:test.failed')
    )
    expect(
      screen.getByText('model-fit:evidence.failed-with-settings')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'model-fit:test.runAgain' })).toBeEnabled()

    // Adjusting the context makes the failure stale rather than permanent.
    act(() => {
      useModelProvider.setState({
        providers: [
          {
            ...useModelProvider.getState().providers[0],
            models: [
              { id: 'qwen3-8b', settings: { ctx_len: { controller_props: { value: 2048 } } } },
            ],
          },
        ] as unknown as ModelProvider[],
      })
    })
    expect(
      await screen.findByText('model-fit:evidence.stale')
    ).toBeInTheDocument()
  })

  it('sets and clears the default model for new chats', async () => {
    renderStatus()
    await openDetails()
    await userEvent.click(screen.getByRole('button', { name: 'model-fit:setDefault' }))
    expect(useModelEvidence.getState().preferredModel).toEqual({
      provider: 'llamacpp',
      model: 'qwen3-8b',
    })
    await userEvent.click(screen.getByRole('button', { name: 'model-fit:removeDefault' }))
    expect(useModelEvidence.getState().preferredModel).toBeNull()
  })
})
