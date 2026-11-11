import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { UIMessageChunk } from 'ai'

const h = vi.hoisted(() => ({
  selectedProvider: 'qa401',
  selectedModel: { id: 'swift15' } as { id: string } | null,
  providers: [] as Array<{ provider: string; active?: boolean; models: { id: string }[] }>,
  threads: {} as Record<string, { id: string; model?: { id: string; provider: string } }>,
}))

vi.mock('sonner', () => ({ toast: { info: vi.fn(), warning: vi.fn() } }))
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: { getState: () => ({ fallbackModels: [] }) },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      selectedProvider: h.selectedProvider,
      selectedModel: h.selectedModel,
      providers: h.providers,
      getProviderByName: (name: string) => h.providers.find((p) => p.provider === name),
    }),
  },
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: {
    getState: () => ({
      threads: h.threads,
      ensureThreadHydrated: async () => {},
      updateThread: () => {},
    }),
  },
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: null }) },
}))

import { CustomChatTransport } from '../custom-chat-transport'
import { ProviderBindingError } from '../threadModelBinding'

class Harness extends CustomChatTransport {
  sent: Array<string | undefined> = []
  protected override async sendOnce(): Promise<ReadableStream<UIMessageChunk>> {
    this.sent.push(this.getModelSelection().selectedProvider)
    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.close()
      },
    })
  }
}

class CoworkLike extends Harness {
  protected override checksProviderBinding = false
}

// Every send of a chat goes through sendMessages: a new message, an edit, a
// regenerate, a retry and a queued message differ only in `trigger` and the
// messages handed in.
const send = (
  t: Harness,
  trigger: 'submit-message' | 'regenerate-message' = 'submit-message',
  role: 'user' | 'assistant' = 'user'
) =>
  t.sendMessages({
    chatId: 'c',
    messages: [{ id: 'm', role, parts: [] }],
    trigger,
  } as never)

describe('a chat only ever sends to the provider it is bound to', () => {
  beforeEach(() => {
    h.selectedProvider = 'qa401'
    h.selectedModel = { id: 'swift15' }
    h.providers = [
      { provider: 'v100b', active: false, models: [{ id: 'swift15' }] },
      { provider: 'qa401', active: true, models: [{ id: 'swift15' }] },
    ]
    h.threads = { t1: { id: 't1', model: { id: 'swift15', provider: 'v100b' } } }
  })

  it.each(['submit-message', 'regenerate-message'] as const)(
    'refuses a %s when the chat provider is off, even though another serves the same model',
    async (trigger) => {
      const t = new Harness('sys', 't1')
      await expect(send(t, trigger)).rejects.toBeInstanceOf(ProviderBindingError)
      expect(t.sent).toEqual([])
    }
  )

  it('refuses a tool follow-up too (assistant last)', async () => {
    const t = new Harness('sys', 't1')
    await expect(send(t, 'submit-message', 'assistant')).rejects.toMatchObject({
      problem: { reason: 'provider-off', provider: 'v100b' },
    })
    expect(t.sent).toEqual([])
  })

  it('refuses another provider while the chat provider is on', async () => {
    h.providers[0].active = true
    const t = new Harness('sys', 't1')
    await expect(send(t)).rejects.toMatchObject({
      problem: { reason: 'other-provider', provider: 'v100b', selected: 'qa401' },
    })
    expect(t.sent).toEqual([])
  })

  it('sends when the selection is the chat provider', async () => {
    h.providers[0].active = true
    h.selectedProvider = 'v100b'
    const t = new Harness('sys', 't1')
    await send(t)
    expect(t.sent).toEqual(['v100b'])
  })

  it('sends after the user picks another model in the chat (the chat moves with it)', async () => {
    h.threads.t1.model = { id: 'swift15', provider: 'qa401' }
    const t = new Harness('sys', 't1')
    await send(t)
    expect(t.sent).toEqual(['qa401'])
  })

  it('leaves a chat with no model yet, and Cowork runs, alone', async () => {
    h.threads = { t1: { id: 't1' } }
    const fresh = new Harness('sys', 't1')
    await send(fresh)
    expect(fresh.sent).toEqual(['qa401'])
    h.threads = { t1: { id: 't1', model: { id: 'swift15', provider: 'v100b' } } }
    const cowork = new CoworkLike('sys', 't1')
    await send(cowork)
    expect(cowork.sent).toEqual(['qa401'])
  })
})
