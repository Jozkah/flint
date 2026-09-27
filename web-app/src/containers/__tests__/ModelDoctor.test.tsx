import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/lib/model-factory', () => ({ ModelFactory: { createModel: vi.fn() } }))
const generateText = vi.fn()
vi.mock('ai', async (orig) => ({
  ...(await orig<typeof import('ai')>()),
  generateText: (...a: unknown[]) => generateText(...a),
}))

import { ModelDoctor, probeModelParams } from '../ModelDoctor'
import { BACKGROUND_SLOT_ID } from '@/constants/models'
import { useModelDoctor } from '@/hooks/useModelDoctor'
import { PROBE_TOOL } from '@/lib/modelDoctor'

const provider: ProviderObject = {
  active: true,
  provider: 'custom',
  base_url: 'http://127.0.0.1:8080/v1',
  settings: [],
  models: [],
}
const model: Model = { id: 'm1', capabilities: ['tools'] }

describe('ModelDoctor', () => {
  beforeEach(() => {
    generateText.mockReset()
    useModelDoctor.setState({ results: {}, running: {} })
  })

  it('runs only when asked, through the given transport, and shows what it observed', async () => {
    const createModel = vi.fn(async () => ({}) as never)
    render(<ModelDoctor provider={provider} model={model} createModel={createModel} />)
    expect(createModel).not.toHaveBeenCalled()
    expect(generateText).not.toHaveBeenCalled()

    generateText
      .mockResolvedValueOnce({
        text: '',
        finishReason: 'tool-calls',
        toolCalls: [{ toolCallId: 'a', toolName: PROBE_TOOL, input: { city: 'Oslo', unit: 'celsius' } }],
      })
      .mockImplementationOnce(async (args: { messages: Array<{ role: string; content: unknown }> }) => {
        const code = /"verification_code":"([A-Z0-9]+)"/.exec(JSON.stringify(args.messages))![1]
        return { text: `code ${code}`, finishReason: 'stop', toolCalls: [] }
      })
    fireEvent.click(screen.getByTestId('model-doctor-test'))
    const verdict = await screen.findByTestId('model-doctor-verdict')
    expect(verdict.getAttribute('data-outcome')).toBe('passed')
    expect(createModel).toHaveBeenCalledWith(provider, model)
    expect(screen.getByTestId('model-doctor-report').textContent).toContain('common:modelDoctor.limits')
  })

  it('shows a result recorded under other settings as stale', async () => {
    const createModel = vi.fn(async () => ({}) as never)
    generateText.mockResolvedValue({ text: 'no', finishReason: 'stop', toolCalls: [] })
    const { rerender } = render(
      <ModelDoctor provider={provider} model={model} createModel={createModel} />
    )
    fireEvent.click(screen.getByTestId('model-doctor-test'))
    await waitFor(() =>
      expect(screen.getByTestId('model-doctor-verdict').getAttribute('data-outcome')).toBe('failed')
    )
    rerender(
      <ModelDoctor
        provider={{ ...provider, base_url: 'http://127.0.0.1:9090/v1' }}
        model={model}
        createModel={createModel}
      />
    )
    expect(screen.getByTestId('model-doctor-stale')).toBeTruthy()
    expect(screen.queryByTestId('model-doctor-verdict')).toBeNull()
  })

  it('builds the run request parameters, on llama.cpp in the background slot', () => {
    const llama = { ...provider, provider: 'llamacpp' }
    const withTemp: Model = {
      ...model,
      settings: {
        temperature: {
          key: 'temperature',
          title: '',
          description: '',
          controller_type: 'input',
          controller_props: { value: 0.2 },
        },
      },
    }
    expect(probeModelParams(llama, withTemp)).toMatchObject({
      temperature: 0.2,
      id_slot: BACKGROUND_SLOT_ID,
    })
    expect(probeModelParams(provider, model).id_slot).toBeUndefined()
  })
})
