import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

// Each transport remembers the thread it was made for.
vi.mock('@/lib/custom-chat-transport', () => ({
  CustomChatTransport: class {
    threadId?: string
    constructor(_system?: string, threadId?: string) {
      this.threadId = threadId
    }
    setMemoryBinding() {}
    updateSystemMessage() {}
    setModelSelectionResolver() {}
    setOnTokenUsage() {}
    updateRagToolsAvailability() {}
    refreshTools() {}
    setContinueFromContent() {}
  },
}))

vi.mock('@ai-sdk/react', () => ({
  Chat: class {
    constructor(public init: unknown) {}
    stop() {}
  },
  useChat: () => ({ messages: [], status: 'ready', setMessages: () => {} }),
}))

vi.mock('@/hooks/useChatMemoryBinding', () => ({ useChatMemoryBinding: () => {} }))

import { useChat } from '../use-chat'
import { useChatSessions } from '@/stores/chat-session-store'

type WithThread = { threadId?: string }

describe('useChat transport per session', () => {
  beforeEach(() => {
    useChatSessions.getState().clearSessions()
  })

  // The chat view stays mounted when it moves to another thread. Reusing the
  // previous transport carried its thread id and its frozen MCP tool routing
  // into the new chat, so a request naming a server could not reach it.
  it('gives a newly opened chat its own transport', () => {
    const { rerender } = renderHook(({ id }) => useChat({ sessionId: id }), {
      initialProps: { id: 'thread-a' },
    })
    const a = useChatSessions.getState().sessions['thread-a']?.transport as WithThread
    rerender({ id: 'thread-b' })
    const b = useChatSessions.getState().sessions['thread-b']?.transport as WithThread
    expect(a?.threadId).toBe('thread-a')
    expect(b?.threadId).toBe('thread-b')
    expect(b).not.toBe(a)
  })

  it('returns to a chat with the transport it already has', () => {
    const { rerender } = renderHook(({ id }) => useChat({ sessionId: id }), {
      initialProps: { id: 'thread-a' },
    })
    const a = useChatSessions.getState().sessions['thread-a']?.transport
    rerender({ id: 'thread-b' })
    rerender({ id: 'thread-a' })
    expect(useChatSessions.getState().sessions['thread-a']?.transport).toBe(a)
  })
})
