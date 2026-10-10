import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { CustomChatTransport } from '../custom-chat-transport'

const h = vi.hoisted(() => ({
  selectedProvider: 'llamacpp',
  selectedModel: { id: 'model-a' } as { id: string },
}))

vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: { getState: () => ({ fallbackModels: [] }) },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      selectedProvider: h.selectedProvider,
      selectedModel: h.selectedModel,
      providers: [],
      getProviderByName: () => null,
    }),
  },
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: null }) },
}))

class Harness extends CustomChatTransport {
  seen: Array<string | undefined> = []
  protected override async sendOnce(): Promise<ReadableStream<UIMessageChunk>> {
    this.seen.push(this.getModelSelection().selectedModel?.id)
    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.close()
      },
    })
  }
}

const send = (t: Harness, role: 'user' | 'assistant') =>
  t.sendMessages({
    chatId: 'c',
    messages: [{ id: 'm', role, parts: [] }],
    trigger: 'submit-message',
  } as never)

describe('a chat run keeps the model it was sent with', () => {
  let t: Harness
  beforeEach(() => {
    h.selectedProvider = 'llamacpp'
    h.selectedModel = { id: 'model-a' }
    t = new Harness('sys', 'thread-1')
  })

  it('does not follow the global picker while the tool loop continues', async () => {
    await send(t, 'user')
    // Another chat changes the picker mid-run.
    h.selectedModel = { id: 'model-b' }
    await send(t, 'assistant')
    await send(t, 'assistant')
    expect(t.seen).toEqual(['model-a', 'model-a', 'model-a'])
  })

  it('uses the picker again for the next message', async () => {
    await send(t, 'user')
    h.selectedModel = { id: 'model-b' }
    await send(t, 'user')
    expect(t.seen).toEqual(['model-a', 'model-b'])
  })
})
