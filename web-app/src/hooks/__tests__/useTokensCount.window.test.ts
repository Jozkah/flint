import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ThreadMessage } from '@janhq/core'
import { useTokensCount } from '../useTokensCount'
import { useContextBreakdown } from '../useContextBreakdown'
import { useAssistant } from '../useAssistant'
import { useThreads } from '../useThreads'

const h = vi.hoisted(() => ({ fetchWindow: vi.fn() }))
vi.mock('@/lib/serverWindow', () => ({ fetchServerWindow: h.fetchWindow }))
// No local engine answers: a model unloaded after sitting idle.
vi.mock('@/lib/llamacppRouterProps', () => ({ getLocalPropsExtension: () => undefined }))

// A custom OpenAI-compatible server: not a bundled engine, so the counter has
// no runtime to ask for the window.
const state = {
  selectedModel: { id: 'pxa-qwen3.8-27b', name: 'pxa', capabilities: [] },
  selectedProvider: 'Qwen 3.8 500k (8081)',
  baseUrl: 'http://127.0.0.1:8081/v1' as string | undefined,
}
vi.mock('../useModelProvider', () => ({
  useModelProvider: () => ({
    selectedModel: state.selectedModel,
    selectedProvider: state.selectedProvider,
    getProviderByName: () => ({ base_url: state.baseUrl, settings: [] }),
  }),
}))

const reply = {
  id: 'm1',
  object: 'thread.message',
  thread_id: 'thread-1',
  role: 'assistant',
  content: [],
  status: 'ready',
  created_at: 1,
  completed_at: 1,
  metadata: { usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } },
} as unknown as ThreadMessage

describe('the window of a custom server', () => {
  beforeEach(() => {
    h.fetchWindow.mockReset()
    state.baseUrl = 'http://127.0.0.1:8081/v1'
    act(() => {
      useAssistant.setState({ currentAssistant: undefined })
      useThreads.setState({ threads: {} })
    })
    act(() => {
      useContextBreakdown.setState({
        byId: {},
        windowById: {},
        windowModelById: {},
        lastById: {},
      })
    })
  })

  it('has none to begin with, so the counter shows the plain badge', () => {
    h.fetchWindow.mockResolvedValue(null)
    const { result } = renderHook(() => useTokensCount([reply]))
    expect(result.current.maxTokens).toBeUndefined()
  })

  it('learns it from the server and keeps it with the chat', async () => {
    h.fetchWindow.mockResolvedValue(500_000)
    const { result } = renderHook(() => useTokensCount([reply]))
    await waitFor(() => expect(result.current.maxTokens).toBe(500_000))
    expect(useContextBreakdown.getState().windowById['thread-1']).toBe(500_000)
  })

  it('uses the server window for a session outside chat threads', async () => {
    act(() => useAssistant.setState({
      currentAssistant: { id: 'flint', parameters: { max_context_tokens: 200_000 } } as Assistant,
    }))
    h.fetchWindow.mockResolvedValue(262_144)
    const { result } = renderHook(() => useTokensCount([], { threadId: 'cowork-session' }))
    await waitFor(() => expect(h.fetchWindow).toHaveBeenCalled())
    await waitFor(() => expect(result.current.maxTokens).toBe(262_144))
  })

  it('uses the server window for a chat thread', async () => {
    act(() => {
      useAssistant.setState({
        currentAssistant: { id: 'other', parameters: { max_context_tokens: 100_000 } } as Assistant,
      })
      useThreads.setState({ threads: {
        'thread-1': { id: 'thread-1', assistants: [
          { id: 'flint', parameters: { max_context_tokens: 200_000 } },
        ] } as Thread,
      } })
    })
    h.fetchWindow.mockResolvedValue(262_144)
    const { result } = renderHook(() => useTokensCount([reply]))
    await waitFor(() => expect(h.fetchWindow).toHaveBeenCalled())
    await waitFor(() => expect(result.current.maxTokens).toBe(262_144))
  })

  it('shows the window kept from earlier before the server has answered', () => {
    // An old chat, opened again: the number is there at once.
    act(() => {
      useContextBreakdown.setState({ windowById: { 'thread-1': 262_144 } })
    })
    h.fetchWindow.mockReturnValue(new Promise(() => undefined))
    const { result } = renderHook(() => useTokensCount([reply]))
    expect(result.current.maxTokens).toBe(262_144)
  })

  it('asks nothing of a provider with no address', () => {
    state.baseUrl = undefined
    renderHook(() => useTokensCount([reply]))
    expect(h.fetchWindow).not.toHaveBeenCalled()
  })

  it('uses a window the user set for the model, before asking the server', () => {
    const set = (v: unknown) =>
      Object.assign(state.selectedModel, {
        settings: { ctx_len: { controller_props: { value: v } } },
      })
    set(131072)
    h.fetchWindow.mockReturnValue(new Promise(() => undefined))
    const { result } = renderHook(() => useTokensCount([reply]))
    expect(result.current.maxTokens).toBe(131072)
    delete (state.selectedModel as Record<string, unknown>).settings
  })

  it('uses a window the provider listed for the model', () => {
    Object.assign(state.selectedModel, { max_model_len: 245000 })
    h.fetchWindow.mockReturnValue(new Promise(() => undefined))
    const { result } = renderHook(() => useTokensCount([reply]))
    expect(result.current.maxTokens).toBe(245000)
    delete (state.selectedModel as Record<string, unknown>).max_model_len
  })
})

describe('the window after being away', () => {
  const DAY = 86_400_000
  beforeEach(() => {
    h.fetchWindow.mockReset()
    state.baseUrl = 'http://127.0.0.1:8081/v1'
    state.selectedProvider = 'Qwen 3.8 500k (8081)'
    state.selectedModel = { id: 'pxa-qwen3.8-27b', name: 'pxa', capabilities: [] }
    act(() => {
      useContextBreakdown.setState({
        byId: {},
        windowById: {},
        windowModelById: {},
        lastById: {},
      })
    })
  })

  it('keeps the window however long the chat sat: age is a label, not an expiry', () => {
    act(() => {
      useContextBreakdown.setState({
        lastById: {
          'thread-1': { used: 25_500, window: 262_144, model: 'pxa-qwen3.8-27b', at: Date.now() - 90 * DAY },
        },
      })
    })
    h.fetchWindow.mockReturnValue(new Promise(() => undefined))
    const { result } = renderHook(() => useTokensCount([reply]))
    expect(result.current.maxTokens).toBe(262_144)
  })

  it('keeps it when the server does not answer on return', async () => {
    act(() => {
      useContextBreakdown.setState({
        windowById: { 'thread-1': 262_144 },
        windowModelById: { 'thread-1': 'pxa-qwen3.8-27b' },
      })
    })
    h.fetchWindow.mockResolvedValue(null)
    const { result } = renderHook(() => useTokensCount([reply]))
    await waitFor(() => expect(h.fetchWindow).toHaveBeenCalled())
    expect(result.current.maxTokens).toBe(262_144)
    expect(useContextBreakdown.getState().windowById['thread-1']).toBe(262_144)
  })

  it('does not hand the old model\'s window to a different model', () => {
    act(() => {
      useContextBreakdown.setState({
        windowById: { 'thread-1': 262_144 },
        windowModelById: { 'thread-1': 'some-other-model' },
        lastById: { 'thread-1': { used: 10, window: 262_144, model: 'some-other-model', at: 1 } },
      })
    })
    h.fetchWindow.mockReturnValue(new Promise(() => undefined))
    const { result } = renderHook(() => useTokensCount([reply]))
    expect(result.current.maxTokens).toBeUndefined()
  })

  it('replaces the kept window with the new one the server reports', async () => {
    act(() => {
      useContextBreakdown.setState({
        windowById: { 'thread-1': 100_000 },
        windowModelById: { 'thread-1': 'pxa-qwen3.8-27b' },
      })
    })
    h.fetchWindow.mockResolvedValue(262_144)
    const { result } = renderHook(() => useTokensCount([reply]))
    await waitFor(() => expect(result.current.maxTokens).toBe(262_144))
  })

  it('a local model that has been unloaded keeps the window it last ran with', () => {
    state.selectedProvider = 'llamacpp'
    state.selectedModel = { id: 'local-model', name: 'local', capabilities: [] }
    act(() => {
      useContextBreakdown.setState({
        lastById: { 'thread-1': { used: 5, window: 32_768, model: 'local-model', at: 1 } },
      })
    })
    const { result } = renderHook(() => useTokensCount([reply]))
    expect(result.current.maxTokens).toBe(32_768)
  })

  it('a local model never loaded falls back to the context set for it', () => {
    state.selectedProvider = 'llamacpp'
    state.selectedModel = {
      id: 'local-model',
      name: 'local',
      capabilities: [],
      settings: { ctx_len: { controller_props: { value: 16384 } } },
    } as never
    const { result } = renderHook(() => useTokensCount([reply]))
    expect(result.current.maxTokens).toBe(16384)
  })
})
