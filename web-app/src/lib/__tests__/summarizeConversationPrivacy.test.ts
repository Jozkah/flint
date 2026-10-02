import { describe, it, expect, vi, beforeEach } from 'vitest'

const { providerName, createModel } = vi.hoisted(() => ({
  providerName: { current: 'openai' },
  createModel: vi.fn(),
}))

vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({ engineSlotsIdle: async () => false }))
vi.mock('../model-factory', () => ({ ModelFactory: { createModel } }))
vi.mock('../utilityAgents', () => ({ runUtilityAgent: vi.fn(async () => 'x') }))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      selectedProvider: providerName.current,
      selectedModel: { id: 'm' },
      getProviderByName: () => ({ provider: providerName.current }),
    }),
  },
}))
vi.mock('@/hooks/useConversationPane', () => ({
  resolveThreadModelSelection: () => ({
    selectedProvider: providerName.current,
    selectedModel: { id: 'm' },
  }),
}))

import { canSummarizeLocally, summarizeConversation } from '../thread-title-summarizer'

describe('hover summary privacy', () => {
  beforeEach(() => createModel.mockClear())

  it.each(['openai', 'anthropic', 'openrouter', 'gemini', 'my-custom'])(
    'never builds a model for %s',
    async (p) => {
      providerName.current = p
      expect(canSummarizeLocally('t1')).toBe(false)
      expect(await summarizeConversation('User: secret', new AbortController().signal, 't1')).toBeNull()
      expect(createModel).not.toHaveBeenCalled()
    }
  )

  it('allows local engines', () => {
    providerName.current = 'llamacpp'
    expect(canSummarizeLocally('t1')).toBe(true)
  })
})
