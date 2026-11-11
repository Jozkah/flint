import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const h = vi.hoisted(() => ({
  lastUsed: { provider: 'qa401', model: 'swift15' } as { provider: string; model: string } | null,
}))

vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate: vi.fn() }) }))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({}),
  getServiceHub: () => ({}),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${JSON.stringify(opts)}` : key,
  }),
  i18n: { t: (key: string) => key },
}))
vi.mock('@/utils/getModelToStart', () => ({ getLastUsedModel: () => h.lastUsed }))
vi.mock('@/lib/mcpMention', () => ({ offerToEnableMentionedServers: async () => {} }))

import { useComposerSend } from '../useComposerSend'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelReplacePrompt } from '@/hooks/useModelReplacePrompt'

const v100b = { provider: 'v100b', active: false, models: [{ id: 'swift15' }], settings: [] }
const qa401 = { provider: 'qa401', active: true, models: [{ id: 'swift15' }], settings: [] }
const thread = { id: 't1', title: 'B', model: { id: 'swift15', provider: 'v100b' } }

function setup(over: Record<string, unknown> = {}) {
  const selectModelProvider = vi.fn()
  const setMessage = vi.fn()
  const onSubmit = vi.fn()
  const deps = {
    modelSelection: undefined,
    currentThread: thread,
    selectModelProvider,
    latestPromptRef: { current: 'hello' },
    setWebOffPrompt: vi.fn(),
    webSearchEnabled: true,
    slashCommands: {
      isBuiltin: () => false,
      prepareSend: async (text: string) => ({ kind: 'none', text }),
    },
    selectedModel: null,
    unavailableModel: undefined,
    allProviders: [v100b, qa401],
    preferredModel: null,
    setMessage,
    attachments: [],
    selectedProvider: '',
    requestCapabilities: vi.fn(),
    setPrompt: vi.fn(),
    resolvePromptReferences: async (text: string) => ({ text, resolvedContents: '' }),
    scopeKey: undefined,
    currentThreadId: 't1',
    ownsToolSet: true,
    effectiveAgentMode: false,
    canSummarize: false,
    attachmentsKey: 't1',
    addToHistory: vi.fn(),
    onSubmit,
    isStreaming: false,
    threadBusy: false,
    queueId: 't1',
    restoredDraftRef: { current: null },
    isAgentMode: false,
    agentModeKey: 't1',
    projectId: undefined,
    assistants: [],
    selectedAssistantId: undefined,
    setCurrentAssistant: vi.fn(),
    webSearchScope: undefined,
    prompt: 'hello',
    ...over,
  }
  const hook = renderHook(() => useComposerSend(deps as never))
  return { hook, selectModelProvider, setMessage, onSubmit }
}

describe('sending in a chat whose provider is off', () => {
  beforeEach(() => {
    h.lastUsed = { provider: 'qa401', model: 'swift15' }
    useModelProvider.setState({
      providers: [v100b, qa401] as never,
      selectedProvider: '',
      selectedModel: null,
    })
    useModelProvider.getState().updateProvider('v100b', { active: false })
    useModelReplacePrompt.setState({ request: null })
  })

  it('asks the user, and never switches to another provider serving the same model', async () => {
    const { hook, selectModelProvider, onSubmit } = setup()
    let done: Promise<void> | undefined
    act(() => {
      done = hook.result.current.handleSendMessage('hello')
    })
    const request = useModelReplacePrompt.getState().request
    expect(request?.offProvider).toBe('v100b')
    expect(request?.missing).toEqual([{ id: 'swift15', provider: 'v100b' }])
    // Cancelled: nothing goes anywhere.
    await act(async () => {
      useModelReplacePrompt.getState().answer(null)
      await done
    })
    expect(selectModelProvider).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('a second press does not slip past the question either', async () => {
    const { hook, selectModelProvider, onSubmit } = setup()
    act(() => {
      void hook.result.current.handleSendMessage('hello')
    })
    await act(async () => {
      useModelReplacePrompt.getState().answer(null)
    })
    act(() => {
      void hook.result.current.handleSendMessage('hello')
    })
    await act(async () => {
      useModelReplacePrompt.getState().answer(null)
    })
    expect(selectModelProvider).not.toHaveBeenCalledWith('qa401', 'swift15')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('turning the provider back on keeps the chat on it', async () => {
    const { hook, selectModelProvider, onSubmit } = setup()
    act(() => {
      void hook.result.current.handleSendMessage('hello')
    })
    const request = useModelReplacePrompt.getState().request!
    await act(async () => {
      useModelProvider.getState().updateProvider('v100b', { active: true })
      useModelReplacePrompt.getState().answer(
        Object.fromEntries(request.missing.map((m) => [`${m.provider}\u0000${m.id}`, m]))
      )
    })
    expect(selectModelProvider).toHaveBeenCalledWith('v100b', 'swift15')
    expect(selectModelProvider).not.toHaveBeenCalledWith('qa401', expect.anything())
    // Parked until the model shows; never sent elsewhere meanwhile.
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('sending with nothing selected', () => {
  beforeEach(() => {
    h.lastUsed = { provider: 'qa401', model: 'swift15' }
    useModelProvider.setState({
      providers: [{ ...v100b, active: true }, qa401] as never,
      selectedProvider: '',
      selectedModel: null,
    })
    useModelReplacePrompt.setState({ request: null })
  })

  it('a chat bound to a provider says so instead of picking the last-used one', async () => {
    const { hook, selectModelProvider, setMessage, onSubmit } = setup()
    await act(async () => {
      await hook.result.current.handleSendMessage('hello')
    })
    expect(selectModelProvider).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenCalledWith(expect.stringContaining('chat:composer.modelUnavailable'))
  })

  it('a new chat still picks the model that should answer', async () => {
    const { hook, selectModelProvider } = setup({ currentThread: undefined, currentThreadId: undefined })
    await act(async () => {
      await hook.result.current.handleSendMessage('hello')
    })
    expect(selectModelProvider).toHaveBeenCalledWith('qa401', 'swift15')
  })
})
