import { describe, expect, it } from 'vitest'
import { mergeRequestParams } from '@/lib/chat/transport/requestParams'

const base = {
  modelSamplingDefaults: {},
  inferenceParams: undefined,
  reasoningParams: {},
  providerId: 'llamacpp',
  selectedModel: undefined,
}

describe('mergeRequestParams', () => {
  it('layers sampling defaults, then assistant params, then reasoning params', () => {
    const out = mergeRequestParams({
      ...base,
      modelSamplingDefaults: { temperature: 0.2, top_p: 0.9 },
      inferenceParams: { temperature: 0.7 },
      reasoningParams: { top_p: 0.5, chat_template_kwargs: { a: 1 } },
    })
    expect(out).toEqual({
      temperature: 0.7,
      top_p: 0.5,
      chat_template_kwargs: { a: 1 },
    })
  })

  it('keeps the model stop strings when the assistant stop is blank', () => {
    expect(
      mergeRequestParams({
        ...base,
        modelSamplingDefaults: { stop: ['</s>'] },
        inferenceParams: { stop: '  ' },
      }).stop
    ).toEqual(['</s>'])
    expect(
      'stop' in
        mergeRequestParams({ ...base, inferenceParams: { stop: '' } })
    ).toBe(false)
  })

  it('pins the llama.cpp slot only for llamacpp', () => {
    const slot = { id_slot: 0, thread_id: 't1' }
    expect(mergeRequestParams({ ...base, slotParams: slot })).toMatchObject(slot)
    expect(
      mergeRequestParams({ ...base, providerId: 'custom', slotParams: slot })
    ).toEqual({})
  })

  it('strips wire-level sampler keys for a predefined remote provider but keeps OpenRouter shaping', () => {
    const out = mergeRequestParams({
      ...base,
      providerId: 'openrouter',
      inferenceParams: {
        temperature: 0.4,
        top_k: 5,
        openrouter_web_search: true,
      },
    })
    expect(out.openrouter_web_search).toBe(true)
    expect('top_k' in out).toBe(false)
    expect('temperature' in out).toBe(false)
  })
})
