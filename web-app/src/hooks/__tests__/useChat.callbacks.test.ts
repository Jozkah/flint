import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('@/lib/custom-chat-transport', () => ({
  CustomChatTransport: class {
    setMemoryBinding() {}
    updateSystemMessage() {}
    setModelSelectionResolver() {}
    setOnTokenUsage() {}
    updateRagToolsAvailability() {}
    refreshTools() {}
    setContinueFromContent() {}
  },
}))

// The mock Chat keeps what it was built with, and `stop` is observable, so a
// test can drive the callbacks the way the SDK does.
let stopCalls = 0
let sdkMessages: unknown[] = []
const setMessagesSpy = vi.fn((update: unknown) => {
  sdkMessages =
    typeof update === 'function'
      ? (update as (m: unknown[]) => unknown[])(sdkMessages)
      : (update as unknown[])
})
vi.mock('@ai-sdk/react', () => ({
  Chat: class {
    messages: unknown[] = []
    constructor(public init: Record<string, (...a: unknown[]) => unknown>) {}
    async stop() {
      stopCalls++
    }
  },
  useChat: () => ({
    messages: sdkMessages,
    status: 'ready',
    setMessages: setMessagesSpy,
    stop: async () => {
      stopCalls++
    },
  }),
}))

vi.mock('@/hooks/useChatMemoryBinding', () => ({ useChatMemoryBinding: () => {} }))

import { useChat } from '../use-chat'
import { useChatSessions } from '@/stores/chat-session-store'
import { STOPPED_TOOL_ERROR } from '@/lib/stopped-tool-calls'

type InitCallbacks = {
  onFinish?: (event: Record<string, unknown>) => unknown
  onToolCall?: (event: Record<string, unknown>) => unknown
}
const chatInit = (id: string) =>
  (useChatSessions.getState().sessions[id]?.chat as unknown as {
    init: InitCallbacks
  }).init

const stoppedToolMessage = () => ({
  id: 'a1',
  role: 'assistant',
  parts: [
    { type: 'tool-slow', toolCallId: 'c1', input: {}, state: 'input-available' },
  ],
})

describe('useChat callbacks', () => {
  beforeEach(() => {
    useChatSessions.getState().clearSessions()
    stopCalls = 0
    sdkMessages = []
    setMessagesSpy.mockClear()
  })

  // The Chat lives on the session, past the component that made it. A view that
  // is rebuilt (the page remounts) brings new callbacks; the Chat built for the
  // first mount must not keep calling the first mount's closures.
  it('calls the latest onFinish after the view remounts', () => {
    const first = vi.fn()
    const second = vi.fn()
    const a = renderHook(() => useChat({ sessionId: 't1', onFinish: first }))
    a.unmount()
    renderHook(() => useChat({ sessionId: 't1', onFinish: second }))

    chatInit('t1').onFinish!({ message: { id: 'm' }, messages: [], isAbort: false })

    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('calls the latest onToolCall after a rerender with a new callback', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(
      ({ cb }) => useChat({ sessionId: 't1', onToolCall: cb }),
      { initialProps: { cb: first } }
    )
    rerender({ cb: second })

    chatInit('t1').onToolCall!({ toolCall: { toolCallId: 'c1' } })

    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('does not fail when no callback was given', () => {
    renderHook(() => useChat({ sessionId: 't1' }))
    expect(() =>
      chatInit('t1').onFinish!({ message: { id: 'm' }, messages: [], isAbort: false })
    ).not.toThrow()
  })

  // Stop only aborts the stream. The call that was still being written or
  // waiting to run is saved as it was, so it kept saying "Running" after every
  // reload.
  it('hands onFinish a stopped turn with its unfinished tool call settled', () => {
    const onFinish = vi.fn()
    renderHook(() => useChat({ sessionId: 't1', onFinish }))
    const message = stoppedToolMessage()

    chatInit('t1').onFinish!({ message, messages: [message], isAbort: true })

    const event = onFinish.mock.calls[0][0] as {
      message: { parts: unknown[]; metadata: unknown }
      messages: Array<{ parts: unknown[] }>
    }
    expect(event.message.parts[0]).toMatchObject({
      state: 'output-error',
      errorText: STOPPED_TOOL_ERROR,
    })
    expect(event.message.metadata).toMatchObject({ stopped: true })
    expect(event.messages[0].parts[0]).toMatchObject({ state: 'output-error' })
  })

  it('leaves a turn that finished on its own as it was', () => {
    const onFinish = vi.fn()
    renderHook(() => useChat({ sessionId: 't1', onFinish }))
    const message = stoppedToolMessage()

    chatInit('t1').onFinish!({ message, messages: [message], isAbort: false })

    expect(onFinish.mock.calls[0][0]).toMatchObject({ message })
  })

  it('settles the live turn when Stop is pressed', async () => {
    const message = stoppedToolMessage()
    sdkMessages = [message]
    const { result } = renderHook(() => useChat({ sessionId: 't1' }))

    await result.current.stop()

    expect(stopCalls).toBe(1)
    expect((sdkMessages[0] as { parts: unknown[] }).parts[0]).toMatchObject({
      state: 'output-error',
      errorText: STOPPED_TOOL_ERROR,
    })
  })
})
