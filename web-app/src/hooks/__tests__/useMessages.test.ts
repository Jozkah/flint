import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMessages } from '../useMessages'
import { ThreadMessage } from '@janhq/core'

// Mock the ServiceHub
const mockCreateMessage = vi.fn()
const mockModifyMessage = vi.fn()
const mockDeleteMessage = vi.fn()

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    messages: () => ({
      createMessage: mockCreateMessage,
      modifyMessage: mockModifyMessage,
      deleteMessage: mockDeleteMessage,
    }),
  }),
}))


describe('useMessages', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset store state
    useMessages.setState({ messages: {} })
  })

  it('should initialize with empty messages', () => {
    const { result } = renderHook(() => useMessages())

    expect(result.current.messages).toEqual({})
  })

  describe('getMessages', () => {
    it('should return empty array for non-existent thread', () => {
      const { result } = renderHook(() => useMessages())

      const messages = result.current.getMessages('non-existent-thread')
      expect(messages).toEqual([])
    })

    it('should return messages for existing thread', () => {
      const { result } = renderHook(() => useMessages())

      const testMessages: ThreadMessage[] = [
        {
          id: 'msg1',
          thread_id: 'thread1',
          role: 'user',
          content: 'Hello',
          created_at: Date.now(),
        },
        {
          id: 'msg2',
          thread_id: 'thread1',
          role: 'assistant',
          content: 'Hi there!',
          created_at: Date.now(),
        },
      ]

      act(() => {
        result.current.setMessages('thread1', testMessages)
      })

      const messages = result.current.getMessages('thread1')
      expect(messages).toEqual(testMessages)
    })
  })

  describe('setMessages', () => {
    it('should set messages for a thread', () => {
      const { result } = renderHook(() => useMessages())

      const testMessages: ThreadMessage[] = [
        {
          id: 'msg1',
          thread_id: 'thread1',
          role: 'user',
          content: 'Hello',
          created_at: Date.now(),
        },
      ]

      act(() => {
        result.current.setMessages('thread1', testMessages)
      })

      expect(result.current.messages['thread1']).toEqual(testMessages)
    })

    it('should handle multiple threads', () => {
      const { result } = renderHook(() => useMessages())

      const thread1Messages: ThreadMessage[] = [
        {
          id: 'msg1',
          thread_id: 'thread1',
          role: 'user',
          content: 'Hello from thread 1',
          created_at: Date.now(),
        },
      ]

      const thread2Messages: ThreadMessage[] = [
        {
          id: 'msg2',
          thread_id: 'thread2',
          role: 'user',
          content: 'Hello from thread 2',
          created_at: Date.now(),
        },
      ]

      act(() => {
        result.current.setMessages('thread1', thread1Messages)
        result.current.setMessages('thread2', thread2Messages)
      })

      expect(result.current.messages['thread1']).toEqual(thread1Messages)
      expect(result.current.messages['thread2']).toEqual(thread2Messages)
    })

    it('should replace existing messages', () => {
      const { result } = renderHook(() => useMessages())

      const initialMessages: ThreadMessage[] = [
        {
          id: 'msg1',
          thread_id: 'thread1',
          role: 'user',
          content: 'Initial message',
          created_at: Date.now(),
        },
      ]

      const newMessages: ThreadMessage[] = [
        {
          id: 'msg2',
          thread_id: 'thread1',
          role: 'user',
          content: 'New message',
          created_at: Date.now(),
        },
      ]

      act(() => {
        result.current.setMessages('thread1', initialMessages)
      })

      expect(result.current.messages['thread1']).toEqual(initialMessages)

      act(() => {
        result.current.setMessages('thread1', newMessages)
      })

      expect(result.current.messages['thread1']).toEqual(newMessages)
    })
  })

  describe('addMessage', () => {
    it('should add message and call createMessage service', async () => {
      const { result } = renderHook(() => useMessages())

      const mockCreatedMessage: ThreadMessage = {
        id: 'created-msg',
        thread_id: 'thread1',
        role: 'user',
        content: 'Test message',
        created_at: Date.now(),
      }

      mockCreateMessage.mockResolvedValue(mockCreatedMessage)

      const messageToAdd: ThreadMessage = {
        id: 'temp-msg',
        thread_id: 'thread1',
        role: 'user',
        content: 'Test message',
        created_at: Date.now(),
      }

      act(() => {
        result.current.addMessage(messageToAdd)
      })

      expect(mockCreateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: messageToAdd.id,
          thread_id: messageToAdd.thread_id,
          role: messageToAdd.role,
          content: messageToAdd.content,
        })
      )

      // Message should be immediately available (optimistic update)
      expect(result.current.messages['thread1']).toContainEqual(
        expect.objectContaining({
          id: messageToAdd.id,
          thread_id: messageToAdd.thread_id,
          role: messageToAdd.role,
          content: messageToAdd.content,
        })
      )

      // Verify persistence was attempted
      await vi.waitFor(() => {
        expect(mockCreateMessage).toHaveBeenCalled()
      })
    })

    it('should handle message without created_at', async () => {
      const { result } = renderHook(() => useMessages())

      const mockCreatedMessage: ThreadMessage = {
        id: 'created-msg',
        thread_id: 'thread1',
        role: 'user',
        content: 'Test message',
        created_at: Date.now(),
      }

      mockCreateMessage.mockResolvedValue(mockCreatedMessage)

      const messageToAdd: ThreadMessage = {
        id: 'temp-msg',
        thread_id: 'thread1',
        role: 'user',
        content: 'Test message',
        // no created_at provided
      } as ThreadMessage

      act(() => {
        result.current.addMessage(messageToAdd)
      })

      expect(mockCreateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          created_at: expect.any(Number),
        })
      )
    })

    it('should preserve existing metadata', async () => {
      const { result } = renderHook(() => useMessages())

      const mockCreatedMessage: ThreadMessage = {
        id: 'created-msg',
        thread_id: 'thread1',
        role: 'user',
        content: 'Test message',
        created_at: Date.now(),
        metadata: {
          customField: 'custom value',
        },
      }

      mockCreateMessage.mockResolvedValue(mockCreatedMessage)

      const messageToAdd: ThreadMessage = {
        id: 'temp-msg',
        thread_id: 'thread1',
        role: 'user',
        content: 'Test message',
        created_at: Date.now(),
        metadata: {
          customField: 'custom value',
        },
      }

      act(() => {
        result.current.addMessage(messageToAdd)
      })

      expect(mockCreateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            customField: 'custom value',
          }),
        })
      )
    })
  })

  describe('deleteMessage', () => {
    it('should delete message and call deleteMessage service', () => {
      const { result } = renderHook(() => useMessages())

      const testMessages: ThreadMessage[] = [
        {
          id: 'msg1',
          thread_id: 'thread1',
          role: 'user',
          content: 'Message 1',
          created_at: Date.now(),
        },
        {
          id: 'msg2',
          thread_id: 'thread1',
          role: 'user',
          content: 'Message 2',
          created_at: Date.now(),
        },
      ]

      act(() => {
        result.current.setMessages('thread1', testMessages)
      })

      act(() => {
        result.current.deleteMessage('thread1', 'msg1')
      })

      expect(mockDeleteMessage).toHaveBeenCalledWith('thread1', 'msg1')
      expect(result.current.messages['thread1']).toEqual([testMessages[1]])
    })

    it('restores the message and logs when the backend delete fails (#80)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockDeleteMessage.mockRejectedValueOnce(new Error('disk error'))
      const { result } = renderHook(() => useMessages())
      const testMessages: ThreadMessage[] = [
        { id: 'a', thread_id: 't', role: 'user', content: 'A', created_at: 1 },
        { id: 'b', thread_id: 't', role: 'user', content: 'B', created_at: 2 },
        { id: 'c', thread_id: 't', role: 'user', content: 'C', created_at: 3 },
      ] as ThreadMessage[]
      act(() => {
        result.current.setMessages('t', testMessages)
      })

      act(() => {
        result.current.deleteMessage('t', 'b')
      })
      expect(result.current.messages['t'].map((m) => m.id)).toEqual(['a', 'c'])

      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(result.current.messages['t'].map((m) => m.id)).toEqual(['a', 'b', 'c'])
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to delete message:',
        expect.any(Error)
      )
      errorSpy.mockRestore()
    })

    it('should handle deleting from empty thread', () => {
      const { result } = renderHook(() => useMessages())

      act(() => {
        result.current.deleteMessage('empty-thread', 'non-existent-msg')
      })

      expect(mockDeleteMessage).toHaveBeenCalledWith('empty-thread', 'non-existent-msg')
      expect(result.current.messages['empty-thread']).toEqual([])
    })

    it('should handle deleting non-existent message', () => {
      const { result } = renderHook(() => useMessages())

      const testMessages: ThreadMessage[] = [
        {
          id: 'msg1',
          thread_id: 'thread1',
          role: 'user',
          content: 'Message 1',
          created_at: Date.now(),
        },
      ]

      act(() => {
        result.current.setMessages('thread1', testMessages)
      })

      act(() => {
        result.current.deleteMessage('thread1', 'non-existent-msg')
      })

      expect(mockDeleteMessage).toHaveBeenCalledWith('thread1', 'non-existent-msg')
      expect(result.current.messages['thread1']).toEqual(testMessages)
    })
  })

  describe('state management', () => {
    it('should maintain state across multiple hook instances', () => {
      const { result: result1 } = renderHook(() => useMessages())
      const { result: result2 } = renderHook(() => useMessages())

      const testMessage: ThreadMessage = {
        id: 'msg1',
        thread_id: 'thread1',
        role: 'user',
        content: 'Test message',
        created_at: Date.now(),
      }

      act(() => {
        result1.current.setMessages('thread1', [testMessage])
      })

      expect(result2.current.getMessages('thread1')).toEqual([testMessage])
    })
  })
})

describe('useMessages addMessage persist echo (#178)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useMessages.setState({ messages: {} })
  })

  const msg: ThreadMessage = {
    id: 'm1',
    thread_id: 't1',
    role: 'user',
    content: 'Hello',
    created_at: 1,
  } as ThreadMessage

  it('does not let the createMessage echo undo a newer updateMessage', async () => {
    let resolveCreate!: (m: ThreadMessage) => void
    mockCreateMessage.mockReturnValue(
      new Promise<ThreadMessage>((resolve) => {
        resolveCreate = resolve
      })
    )
    mockModifyMessage.mockResolvedValue(undefined)

    act(() => {
      useMessages.getState().addMessage(msg)
    })
    act(() => {
      useMessages.getState().updateMessage({
        ...msg,
        metadata: { error: 'x' },
      } as ThreadMessage)
    })

    await act(async () => {
      resolveCreate({ ...msg })
      await Promise.resolve()
    })

    const stored = useMessages.getState().getMessages('t1')
    expect(stored).toHaveLength(1)
    expect(stored[0].metadata).toEqual({ error: 'x' })
  })

  it('still applies the echo when nothing changed meanwhile', async () => {
    const persisted = { ...msg, content: 'persisted' } as ThreadMessage
    mockCreateMessage.mockResolvedValue(persisted)

    await act(async () => {
      useMessages.getState().addMessage(msg)
      await Promise.resolve()
    })

    expect(useMessages.getState().getMessages('t1')[0]).toBe(persisted)
  })
})
