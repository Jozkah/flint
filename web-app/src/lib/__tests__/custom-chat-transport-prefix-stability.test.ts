import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useLeanToolsConfig } from '@/hooks/useLeanToolsConfig'
import type { UIMessage } from '@ai-sdk/react'

// Capture every streamText({...}) call so we can compare the prompt prefix
// (system + tools + prior model messages) across consecutive turns.
const streamTextCalls: Array<Record<string, unknown>> = []

const h = vi.hoisted(() => ({
  disabledTools: [] as string[],
  servers: ['srv'] as string[],
  getRelevantTools: vi.fn(),
  getModelProps: vi.fn(),
  assistantParameters: null as Record<string, unknown> | null,
  providerId: 'openai',
  serviceHub: null as unknown,
}))

const mcpService = {
  getTools: vi.fn(async () => []),
  getToolsForServers: vi.fn(async () => []),
  getServerSummaries: vi.fn(async () =>
    h.servers.map((name) => ({ name, capabilities: [], description: '' }))
  ),
}

h.serviceHub = {
  mcp: () => mcpService,
  rag: () => ({ getTools: async () => [] }),
}

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    streamText: (args: Record<string, unknown>) => {
      streamTextCalls.push(args)
      return {
        toUIMessageStream: () =>
          new ReadableStream({
            start(controller) {
              controller.close()
            },
          }),
      }
    },
  }
})

const provider = {
  provider: 'openai',
  api_key: 'k',
  models: [],
  settings: [] as Array<{ key: string; controller_props: { value: boolean } }>,
}
const selectedModel = { id: 'gpt', capabilities: ['tools'] }

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: h.serviceHub }) },
}))
vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: {
    getState: () => ({ getDisabledTools: () => h.disabledTools }),
  },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      selectedModel,
      selectedProvider: h.providerId,
      getProviderByName: () => provider,
    }),
  },
}))
vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: {
    getState: () => ({
      currentAssistant: h.assistantParameters
        ? { parameters: h.assistantParameters }
        : null,
    }),
  },
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => ({ threads: {} }) },
}))
vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: { getState: () => ({ enabled: false }) },
}))
vi.mock('@/hooks/useMCPServers', () => ({
  useMCPServers: {
    getState: () => ({ settings: { enableSmartToolRouting: true } }),
  },
}))
// Every getState() setter is a no-op; unknown reads (currentStreamThreadId)
// resolve to undefined.
vi.mock('@/hooks/useAppState', () => ({
  useAppState: {
    getState: () =>
      new Proxy(
        {},
        {
          get: () => () => undefined,
        }
      ),
  },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))
vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  getLoadedModels: vi.fn(async () => ['llama-local']),
  unloadLlamaModel: vi.fn(),
}))
vi.mock('@/lib/llamacppRouterProps', () => ({
  getLlamacppExtension: () => ({ getModelProps: h.getModelProps }),
}))
vi.mock('@/lib/mcp-orchestrator', () => ({
  mcpOrchestrator: { getRelevantTools: h.getRelevantTools },
}))
vi.mock('@/lib/mcp-router-model-filter', () => ({
  isRouterModelSelectable: () => false,
}))
vi.mock('@/lib/reasoningProviderOptions', () => ({
  buildReasoningProviderOptions: () => undefined,
  buildReasoningBodyParams: () => undefined,
  buildVerbosityProviderOptions: () => undefined,
  mergeProviderOptions: () => undefined,
}))
vi.mock('@/lib/providerCaps', () => ({
  isPredefinedRemoteProvider: () => false,
  getProviderApiType: () => 'openai',
}))
vi.mock('../model-factory', () => ({
  ModelFactory: { createModel: vi.fn(async () => ({ modelId: 'gpt' })) },
  // The transport tags each model with the conversation it belongs to, so the
  // provider transport can record what was sent.
  DISPATCH_PARAM_KEY: '__janDispatch',
}))

import { CustomChatTransport } from '../custom-chat-transport'
import { ModelFactory } from '../model-factory'
import { useModelOverrides } from '@/hooks/useModelOverrides'

const user = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage
const assistant = (id: string, text: string): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }] }) as UIMessage

async function drain(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
}

const send = (transport: CustomChatTransport, messages: UIMessage[]) =>
  transport.sendMessages({
    chatId: 'thread-1',
    messages,
    abortSignal: undefined,
    trigger: 'submit-message',
    messageId: undefined,
  })

describe('CustomChatTransport prompt-prefix stability across turns', () => {
  beforeEach(() => {
    // These pin trimming and reserves against the full prompt.
    useLeanToolsConfig.setState({ smallContextMode: 'never' })
    streamTextCalls.length = 0
    h.disabledTools = []
    h.servers = ['srv']
    h.providerId = 'openai'
    h.assistantParameters = null
    h.getModelProps.mockReset()
    provider.provider = 'openai'
    provider.settings = []
    selectedModel.id = 'gpt'
    selectedModel.capabilities = ['tools']
    h.getRelevantTools.mockReset()
    h.getRelevantTools.mockResolvedValue([
      { name: 'tool_a', description: 'a', inputSchema: {}, server: 'srv' },
    ])
  })

  it('sends a byte-identical prefix (system + tools + prior turns) on the next turn', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')

    const turn1 = [user('u1', 'hello')]
    await drain(await send(transport, turn1))

    // A new turn: prior turn + assistant reply + new user question.
    const turn2 = [
      ...turn1,
      assistant('a1', 'hi there'),
      user('u2', 'again'),
    ]
    await drain(await send(transport, turn2))

    expect(streamTextCalls).toHaveLength(2)
    const [first, second] = streamTextCalls

    // System prompt is byte-identical.
    expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system))

    // Tool set is byte-identical (frozen for the thread's lifetime).
    expect(JSON.stringify(Object.keys(second.tools as object))).toBe(
      JSON.stringify(Object.keys(first.tools as object))
    )

    // The prior turn's model messages are re-serialized byte-for-byte, so the
    // second request's message array starts with turn 1's exact prefix.
    const firstMessages = first.messages as unknown[]
    const secondMessages = second.messages as unknown[]
    expect(secondMessages.length).toBeGreaterThan(firstMessages.length)
    expect(
      JSON.stringify(secondMessages.slice(0, firstMessages.length))
    ).toBe(JSON.stringify(firstMessages))
  })

  it('trims history to the loaded llama.cpp context window before streaming', async () => {
    h.providerId = 'llamacpp'
    h.getModelProps.mockResolvedValue({ nCtx: 4096 })
    provider.provider = 'llamacpp'
    provider.settings = [
      { key: 'ctx_shift', controller_props: { value: true } },
    ]
    selectedModel.id = 'llama-local'

    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(
      await send(transport, [
        user('u1', `old-user ${'context '.repeat(150)}`),
        assistant('a1', `old-assistant ${'context '.repeat(150)}`),
        user('u2', `latest-user ${'context '.repeat(150)}`),
      ])
    )

    const requestMessages = streamTextCalls[0].messages as unknown[]
    const serialized = JSON.stringify(requestMessages)
    expect(h.getModelProps).toHaveBeenCalledWith('llama-local')
    expect(requestMessages).toHaveLength(1)
    expect(serialized).not.toContain('old-user')
    expect(serialized).toContain('latest-user')
  })

  it('keeps the prefix stable when the third turn extends the second', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')

    const turn2 = [
      user('u1', 'hello'),
      assistant('a1', 'hi there'),
      user('u2', 'again'),
    ]
    await drain(await send(transport, turn2))

    const turn3 = [...turn2, assistant('a2', 'sure'), user('u3', 'more')]
    await drain(await send(transport, turn3))

    expect(streamTextCalls).toHaveLength(2)
    const [second, third] = streamTextCalls
    const secondMessages = second.messages as unknown[]
    const thirdMessages = third.messages as unknown[]
    expect(
      JSON.stringify(thirdMessages.slice(0, secondMessages.length))
    ).toBe(JSON.stringify(secondMessages))
  })

  it('keeps the configured limit when llama.cpp context shift is disabled', async () => {
    h.providerId = 'llamacpp'
    h.getModelProps.mockResolvedValue({ nCtx: 4096 })
    h.assistantParameters = {
      max_context_tokens: 12_000,
      max_output_tokens: 2048,
    }
    provider.provider = 'llamacpp'
    selectedModel.id = 'llama-local'

    const transport = new CustomChatTransport('you are jan', 'thread-ctx-limit')
    await drain(
      await send(transport, [
        // About 700 estimated tokens each: the three fit the configured
        // 12,000-token window after output headroom and safety margin, and
        // would not fit the 4,096 the live context reports.
        user('u1', `first-user ${'context '.repeat(300)}`),
        assistant('a1', `first-assistant ${'context '.repeat(300)}`),
        user('u2', `latest-user ${'context '.repeat(300)}`),
      ])
    )

    const requestMessages = streamTextCalls[0].messages as unknown[]
    expect(h.getModelProps).not.toHaveBeenCalled()
    expect(requestMessages).toHaveLength(3)
  })
})

describe('CustomChatTransport assistant completion (continuation prefill)', () => {
  beforeEach(() => {
    streamTextCalls.length = 0
    h.disabledTools = []
    h.servers = ['srv']
    h.providerId = 'openai'
    h.assistantParameters = null
    h.getModelProps.mockReset()
    provider.provider = 'openai'
    provider.settings = []
    selectedModel.id = 'gpt'
    selectedModel.capabilities = ['tools']
    h.getRelevantTools.mockReset()
    h.getRelevantTools.mockResolvedValue([
      { name: 'tool_a', description: 'a', inputSchema: {}, server: 'srv' },
    ])
  })

  const history: UIMessage[] = [
    user('u1', 'write a poem'),
    assistant('a1', 'here goes'),
    user('u2', 'continue'),
  ]

  it('appends the partial content as a trailing assistant prefill message', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    transport.setContinueFromContent('Roses are red,')
    await drain(await send(transport, history))

    expect(streamTextCalls).toHaveLength(1)
    const messages = streamTextCalls[0].messages as Array<{
      role: string
      content: unknown
    }>
    const last = messages[messages.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.content).toEqual([{ type: 'text', text: 'Roses are red,' }])
  })

  it('prefills reasoning so a turn stopped mid-thinking resumes inside <think>', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    transport.setContinueFromContent({ reasoning: 'let me think', text: '' })
    await drain(await send(transport, history))

    const messages = streamTextCalls[0].messages as Array<{
      role: string
      content: unknown
    }>
    const last = messages[messages.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.content).toEqual([{ type: 'reasoning', text: 'let me think' }])
  })

  it('leaves the cached prefix byte-identical (prefill only appends)', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')

    // Normal send seeds the cache prefix.
    await drain(await send(transport, history))
    // Continuation send of the same history appends the prefill.
    transport.setContinueFromContent('Roses are red,')
    await drain(await send(transport, history))

    expect(streamTextCalls).toHaveLength(2)
    const [normal, cont] = streamTextCalls
    const normalMessages = normal.messages as unknown[]
    const contMessages = cont.messages as unknown[]

    // The prefill adds exactly one trailing message; everything before it is
    // re-serialized byte-for-byte, so llama.cpp reuses the KV cache.
    expect(contMessages).toHaveLength(normalMessages.length + 1)
    expect(JSON.stringify(contMessages.slice(0, normalMessages.length))).toBe(
      JSON.stringify(normalMessages)
    )
  })

  it('consumes the prefill once (next send appends nothing)', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')

    transport.setContinueFromContent('Roses are red,')
    await drain(await send(transport, history))
    // A second send without re-setting must not re-append the prefill.
    await drain(await send(transport, history))

    expect(streamTextCalls).toHaveLength(2)
    const [withPrefill, without] = streamTextCalls
    const withMessages = withPrefill.messages as unknown[]
    const withoutMessages = without.messages as unknown[]
    expect(withMessages).toHaveLength(withoutMessages.length + 1)
    const last = (withoutMessages[withoutMessages.length - 1] as {
      role: string
    }).role
    expect(last).toBe('user')
  })
})

describe('resolveContextShift', () => {
  it('prefers the per-model choice and falls back to the global one', async () => {
    const { resolveContextShift } = await import('../custom-chat-transport')
    expect(resolveContextShift('on', false)).toBe(true)
    expect(resolveContextShift('off', true)).toBe(false)
    expect(resolveContextShift('auto', true)).toBe(true)
    expect(resolveContextShift(undefined, false)).toBe(false)
  })
})

describe('fixed seed reaches the model parameters', () => {
  const seedOf = () => {
    const calls = vi.mocked(ModelFactory.createModel).mock.calls
    return (calls[calls.length - 1][2] as Record<string, unknown>).seed
  }
  const run = async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(await send(transport, [user('u1', 'hello')]))
  }

  beforeEach(() => {
    streamTextCalls.length = 0
    vi.mocked(ModelFactory.createModel).mockClear()
    h.providerId = 'openai'
    h.assistantParameters = null
    provider.provider = 'openai'
    provider.settings = []
    selectedModel.id = 'gpt'
    ;(selectedModel as Record<string, unknown>).settings = {
      seed: { controller_props: { value: '5' } },
    }
    useModelOverrides.getState().resetThread('thread-1')
  })

  it('uses the model default seed as a number', async () => {
    await run()
    expect(seedOf()).toBe(5)
  })

  it('lets a per-chat override beat the model default', async () => {
    useModelOverrides.getState().setForThread('thread-1', 'seed', 7)
    await run()
    expect(seedOf()).toBe(7)
  })

  it('lets the assistant parameter beat both', async () => {
    useModelOverrides.getState().setForThread('thread-1', 'seed', 7)
    h.assistantParameters = { seed: 99 }
    await run()
    expect(seedOf()).toBe(99)
  })

  it('sends no seed for a random (-1 or empty) model default', async () => {
    ;(selectedModel as Record<string, unknown>).settings = {
      seed: { controller_props: { value: '-1' } },
    }
    await run()
    expect(seedOf()).toBeUndefined()
  })
})

describe('CustomChatTransport reply reserve (local vs cloud)', () => {
  beforeEach(() => {
    useLeanToolsConfig.setState({ smallContextMode: 'never' })
    streamTextCalls.length = 0
    h.disabledTools = []
    h.servers = []
    h.assistantParameters = { max_context_tokens: 32_768 }
    h.getModelProps.mockReset()
    h.getModelProps.mockResolvedValue({ nCtx: 32_768 })
    h.getRelevantTools.mockReset()
    h.getRelevantTools.mockResolvedValue([])
    provider.settings = []
    selectedModel.capabilities = ['tools']
  })

  // About 25,300 estimated tokens: fits 32K, but not 32K minus an 8192 reserve.
  const big = () => [user('u1', `summarize ${'pasted '.repeat(12_650)}`)]

  it('sends a 25K prompt to a 32K local model instead of refusing it', async () => {
    h.providerId = 'llamacpp'
    provider.provider = 'llamacpp'
    selectedModel.id = 'llama-local'
    const transport = new CustomChatTransport('you are jan', 'thread-reserve-local')
    await drain(await send(transport, big()))
    expect(streamTextCalls).toHaveLength(1)
  })

  it('still refuses the same prompt on a hosted model with the 8K headroom', async () => {
    h.providerId = 'openai'
    provider.provider = 'openai'
    selectedModel.id = 'gpt'
    const transport = new CustomChatTransport('you are jan', 'thread-reserve-cloud')
    await expect(send(transport, big())).rejects.toThrow('exceeds the available context size')
    expect(streamTextCalls).toHaveLength(0)
  })
})

describe('CustomChatTransport plain chat on a small window', () => {
  beforeEach(() => {
    useLeanToolsConfig.setState({ smallContextMode: 'auto' })
    streamTextCalls.length = 0
    h.disabledTools = []
    h.servers = []
    h.getModelProps.mockReset()
    h.getRelevantTools.mockReset()
    h.getRelevantTools.mockResolvedValue([])
    provider.settings = []
    selectedModel.capabilities = ['tools']
  })

  const local = (window: number) => {
    h.providerId = 'llamacpp'
    provider.provider = 'llamacpp'
    selectedModel.id = 'llama-local'
    h.assistantParameters = { max_context_tokens: window }
    h.getModelProps.mockResolvedValue({ nCtx: window })
  }

  it('leaves the widget tools out of a 32K window', async () => {
    local(32_768)
    const transport = new CustomChatTransport('you are jan', 'thread-lean-small')
    await drain(await send(transport, [user('u1', 'hi')]))
    const tools = Object.keys((streamTextCalls[0].tools as object | undefined) ?? {})
    expect(tools).not.toContain('show_widget')
    expect(tools).not.toContain('visualize_read_me')
  })

  it('keeps them for a large window', async () => {
    local(131_072)
    const transport = new CustomChatTransport('you are jan', 'thread-lean-large')
    await drain(await send(transport, [user('u1', 'hi')]))
    expect(Object.keys(streamTextCalls[0].tools as object)).toContain('show_widget')
  })

  it('small-context mode: leaner tools and prompt at 50K, nothing changed at 131K or when never', async () => {
    const run = async (window: number, mode: 'auto' | 'always' | 'never') => {
      useLeanToolsConfig.setState({ smallContextMode: mode })
      local(window)
      streamTextCalls.length = 0
      const transport = new CustomChatTransport('you are jan', `thread-small-${window}-${mode}`)
      await drain(await send(transport, [user('u1', 'hi')]))
      return {
        tools: Object.keys((streamTextCalls[0].tools as object | undefined) ?? {}),
        system: String(streamTextCalls[0].system),
      }
    }
    const small = await run(50_000, 'auto')
    expect(small.tools).not.toContain('show_widget')
    expect(small.system).not.toContain('# Color')
    const never = await run(50_000, 'never')
    expect(never.tools).toContain('show_widget')
    expect(never.system).toContain('# Color')
    expect((await run(131_072, 'auto')).tools).toContain('show_widget')
    expect((await run(131_072, 'always')).tools).not.toContain('show_widget')
  })

  it('does not teach git/push rules when only read-only tools are offered', async () => {
    local(131_072)
    const transport = new CustomChatTransport('you are jan', 'thread-lean-rules')
    await drain(await send(transport, [user('u1', 'hi')]))
    expect(String(streamTextCalls[0].system)).not.toContain('force-pushing')
  })

  it('skips the retrieval note when every attached file is inline', () => {
    const transport = new CustomChatTransport('you are jan', 'thread-lean-files')
    const block = (mode: string) => [
      user('u1', `summarize\n\n[ATTACHED_FILES]\n- file_id: a, name: a.txt, type: txt, size: 9, mode: ${mode}\n[/ATTACHED_FILES]`),
    ]
    expect(transport.buildFilesSystemInstruction(block('inline'))).toBe('')
    expect(transport.buildFilesSystemInstruction(block('embeddings'))).toContain('retrieval tools')
  })
})
