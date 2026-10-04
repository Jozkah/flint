import { describe, expect, it, vi, beforeEach } from 'vitest'
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
  cc: { enabled: false, sessionStart: [] as string[], promptSubmit: [] as string[] },
  ccCalls: [] as unknown[],
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
vi.mock('@/lib/previewInvoke', () => ({
  invoke: vi.fn(async (command: string, args: unknown) => {
    if (command === 'run_cc_context_hooks') {
      h.ccCalls.push(args)
      return h.cc
    }
    return []
  }),
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

describe('CustomChatTransport Claude Code context hooks', () => {
  beforeEach(() => {
    streamTextCalls.length = 0
    h.ccCalls.length = 0
    h.cc = { enabled: false, sessionStart: [], promptSubmit: [] }
    h.disabledTools = []
    h.servers = []
    h.providerId = 'openai'
    h.assistantParameters = null
    provider.provider = 'openai'
    provider.settings = []
    selectedModel.id = 'gpt'
    selectedModel.capabilities = []
    h.getRelevantTools.mockReset()
    h.getRelevantTools.mockResolvedValue([])
  })

  it('adds nothing when the hooks are not enabled', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(await send(transport, [user('u1', 'hello')]))
    const call = streamTextCalls[0]
    expect(String(call.system)).not.toContain('style on')
    expect(JSON.stringify(call.messages)).not.toContain('<SYSTEM>')
  })

  it('puts SessionStart after the system prompt and UserPromptSubmit on the user message', async () => {
    h.cc = { enabled: true, sessionStart: ['style on'], promptSubmit: ['per prompt'] }
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(await send(transport, [user('u1', 'hello')]))
    expect(h.ccCalls[0]).toMatchObject({ sessionId: 'thread-1', prompt: 'hello' })
    const call = streamTextCalls[0]
    expect(String(call.system)).toContain('you are jan')
    expect(String(call.system)).toMatch(/style on$/)
    const messages = JSON.stringify(call.messages)
    expect(messages).toContain('hello')
    expect(messages).toContain('<SYSTEM>\\nper prompt\\n</SYSTEM>')
  })

  it('a hook failure never blocks the turn', async () => {
    h.cc = undefined as never
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(await send(transport, [user('u1', 'hello')]))
    expect(streamTextCalls).toHaveLength(1)
  })
})
