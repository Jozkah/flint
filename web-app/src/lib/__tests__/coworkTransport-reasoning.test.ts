import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'

// A Cowork step is sent through the chat transport, so the Reasoning control's
// settings -- llama.cpp's thinking budget, reasoning on/off, a provider's
// effort -- must reach the request exactly as they do in chat, read with the
// session's own overrides.

const h = vi.hoisted(() => ({
  createModel: vi.fn(async (..._args: unknown[]) => ({ modelId: 'm' })),
  streamText: vi.fn((..._args: unknown[]) => ({
    toUIMessageStream: () => new ReadableStream({ start: (c) => c.close() }),
  })),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: {
    getState: () => ({
      serviceHub: {
        mcp: () => ({ getTools: vi.fn(async () => []) }),
        rag: () => ({ getTools: async () => [] }),
      },
    }),
  },
  getServiceHub: () => ({ app: () => ({ getJanDataFolder: async () => null }) }),
}))
vi.mock('@/hooks/useAppState', () => ({
  useAppState: {
    getState: () => new Proxy({}, { get: () => () => undefined }),
  },
}))
vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  getLoadedModels: async () => ['qwen'],
  unloadLlamaModel: async () => ({ success: true }),
}))
vi.mock('@/lib/llamacppRouterProps', () => ({
  // The live, post-fit context: 65536 tokens.
  getLlamacppExtension: () => ({ getModelProps: async () => ({ nCtx: 65536 }) }),
}))
vi.mock('@/lib/coworkTools', async (orig) => ({
  ...(await orig<typeof import('../coworkTools')>()),
  buildCoworkTools: vi.fn(async () => ({})),
}))
vi.mock('../model-factory', async (orig) => ({
  ...(await orig<typeof import('../model-factory')>()),
  ModelFactory: { createModel: h.createModel },
}))
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, streamText: h.streamText }
})

import { CoworkChatTransport } from '../coworkTransport'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import { useAssistant } from '@/hooks/useAssistant'

const setting = (value: unknown) => ({ controller_props: { value } })

function provide(provider: string, model: Record<string, unknown>) {
  useModelProvider.setState({
    providers: [
      { provider, active: true, api_key: 'k', base_url: 'http://x', settings: [], models: [model] },
    ] as never,
  })
}

async function send(provider: string, id: string) {
  const t = new CoworkChatTransport('session-1', {
    model: { provider, id },
    planMode: false,
    webSearch: false,
    subagentNames: [],
    allowSubagents: false,
    workspacePath: null,
    readOnlyFolder: null,
  } as never)
  const stream = await t.sendMessages({
    chatId: 'session-1',
    messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as UIMessage],
    abortSignal: undefined,
    trigger: 'submit-message',
    messageId: undefined,
  })
  await stream.getReader().read()
  const params = h.createModel.mock.calls.at(-1)?.[2] as Record<string, unknown>
  const options = h.streamText.mock.calls.at(-1)?.[0] as Record<string, unknown>
  return { params, options }
}

describe('Cowork request reasoning', () => {
  beforeEach(() => {
    h.createModel.mockClear()
    h.streamText.mockClear()
    useModelOverrides.setState({ byThread: {} } as never)
    useAssistant.setState({ currentAssistant: null } as never)
  })

  it('llama.cpp: sends the budget resolved against the live context, clamped to the output limit', async () => {
    provide('llamacpp', {
      id: 'qwen',
      settings: {
        reasoning: setting('on'),
        thinking_budget_tokens: setting('medium'),
      },
    })
    // The output limit the budget is clamped against: the assistant's.
    useAssistant.setState({
      currentAssistant: { id: 'a', parameters: { max_tokens: 8192 } },
    } as never)
    const { params } = await send('llamacpp', 'qwen')
    // Medium = 25% of 65536 = 16384, capped at 80% of the 8192 output limit.
    expect(params.thinking_budget_tokens).toBe(6553)
    expect(params.chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it("llama.cpp: the session's own effort override wins over the model setting", async () => {
    provide('llamacpp', { id: 'qwen', settings: { thinking_budget_tokens: setting('high') } })
    useModelOverrides.getState().setForThread('session-1', 'thinking_budget_tokens', 'low')
    const { params } = await send('llamacpp', 'qwen')
    // Low = 10% of 65536; no output limit is configured, so nothing clamps it.
    expect(params.thinking_budget_tokens).toBe(6554)
  })

  it('sends no token budget to a provider that does not take one', async () => {
    provide('openai', {
      id: 'gpt-5',
      settings: { reasoning: setting('on'), thinking_budget_tokens: setting('high') },
    })
    const { params, options } = await send('openai', 'gpt-5')
    expect(params).not.toHaveProperty('thinking_budget_tokens')
    expect(params).not.toHaveProperty('chat_template_kwargs')
    expect(options.providerOptions).toEqual({
      openai: { reasoningEffort: 'high', reasoningSummary: 'auto' },
    })
  })

  it("exposes the session's native reasoning options for its subagents", () => {
    provide('openai', { id: 'gpt-5.2', settings: { thinking_budget_tokens: setting('low') } })
    useModelOverrides.getState().setForThread('session-1', 'thinking_budget_tokens', 'xhigh')
    const t = new CoworkChatTransport('session-1', {
      model: { provider: 'openai', id: 'gpt-5.2' },
    } as never)
    expect(t.reasoningProviderOptions()).toEqual({
      openai: { reasoningEffort: 'xhigh', reasoningSummary: 'auto' },
    })
  })
})
