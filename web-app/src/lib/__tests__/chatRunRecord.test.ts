import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'

// A failed Chat turn must say why it failed (run.ended carries the error text
// as `detail`), and Cowork steps -- which Cowork records as its own run --
// must not open a second, chat-shaped run that can end `error` while the
// Cowork step succeeds.

const h = vi.hoisted(() => ({
  serviceHub: null as unknown,
  events: [] as Array<{ kind: string; payload: Record<string, unknown> }>,
  fail: undefined as unknown,
}))

h.serviceHub = {
  mcp: () => ({ getTools: vi.fn(async () => []) }),
  rag: () => ({ getTools: async () => [] }),
}

vi.mock('@/lib/eventLog', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/eventLog')
  return {
    ...actual,
    recordEvents: vi.fn(async (events: typeof h.events) => {
      h.events.push(...events)
    }),
  }
})

const provider = { provider: 'llamacpp', api_key: '', models: [] }
const selectedModel = { id: 'qwen3-4b', capabilities: [] as string[] }

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: h.serviceHub }) },
}))
vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: {
    getState: () => ({
      getDisabledTools: () => [],
      getDefaultDisabledTools: () => [],
    }),
  },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      selectedModel,
      selectedProvider: 'llamacpp',
      getProviderByName: () => provider,
    }),
  },
}))
vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: { getState: () => ({ currentAssistant: null }) },
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => ({ threads: {} }) },
}))
vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: { getState: () => ({ enabled: false }) },
}))
vi.mock('@/hooks/useMCPServers', () => ({
  useMCPServers: { getState: () => ({ settings: {} }) },
}))
// Every getState() setter is a no-op; unknown reads resolve to undefined.
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
vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  getLoadedModels: h.getLoadedModels,
  unloadLlamaModel: h.unloadLlamaModel,
}))
vi.mock('@/lib/extension', () => ({
  ExtensionManager: { getInstance: () => ({ get: () => null }) },
}))
vi.mock('@/lib/mcp-orchestrator', () => ({
  mcpOrchestrator: { getRelevantTools: vi.fn() },
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

vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  getLoadedModels: vi.fn(async () => []),
  unloadLlamaModel: vi.fn(async () => ({ success: true })),
}))
vi.mock('../model-factory', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ModelFactory: { createModel: vi.fn(async () => ({ modelId: 'qwen3-4b' })) },
}))
// The stream fails the way a provider error does: the SDK reports it through
// the transport's onError, then finishes.
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    streamText: () => ({
      toUIMessageStream: (opts: {
        onError?: (e: unknown) => string
        onFinish?: (e: unknown) => void
      }) =>
        new ReadableStream({
          start: (c) => {
            if (h.fail !== undefined) opts.onError?.(h.fail)
            else opts.onFinish?.({ responseMessage: undefined })
            c.close()
          },
        }),
    }),
  }
})

import { CustomChatTransport } from '../custom-chat-transport'
import { CoworkChatTransport } from '../coworkTransport'
import { __testing } from '../chatRun'

const user = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage

async function drain(stream: ReadableStream<unknown>) {
  const reader = stream.getReader()
  while (!(await reader.read()).done) {
    /* read to the end */
  }
}

const runEvents = () =>
  h.events.filter((e) => e.kind === 'run.started' || e.kind === 'run.ended')

describe('chat run records', () => {
  beforeEach(() => {
    h.events.length = 0
    h.fail = undefined
    __testing.reset()
  })

  it('records the error text when a chat turn fails', async () => {
    h.fail = new Error('Provider said no')
    const transport = new CustomChatTransport()
    await drain(
      await transport.sendMessages({
        chatId: 'thread-1',
        messages: [user('m1', 'hi')],
        abortSignal: new AbortController().signal,
        trigger: 'submit-message',
        messageId: undefined,
      })
    )
    const ended = h.events.find((e) => e.kind === 'run.ended')
    expect(ended?.payload).toMatchObject({
      stoppedBy: 'error',
      source: 'chat',
      detail: 'Provider said no',
    })
  })

  it('opens no chat run for a Cowork step, even one that fails', async () => {
    h.fail = new Error('transient')
    const transport = new CoworkChatTransport('session-1', {} as never)
    await drain(
      await transport.sendMessages({
        chatId: 'session-1',
        messages: [user('m1', 'hi')],
        abortSignal: new AbortController().signal,
        trigger: 'submit-message',
        messageId: undefined,
      })
    )
    expect(runEvents()).toEqual([])
  })
})
