import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ThreadMessage } from '@janhq/core'
import { useTokensCount } from '../useTokensCount'
import { useContextBreakdown } from '../useContextBreakdown'

const h = vi.hoisted(() => ({ fetchWindow: vi.fn() }))
vi.mock('@/lib/serverWindow', () => ({ fetchServerWindow: h.fetchWindow }))

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
      useContextBreakdown.setState({ byId: {}, windowById: {} })
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
