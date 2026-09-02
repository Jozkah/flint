import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The orchestration under a temporary chat's two exits. Every store and every
// service it touches is mocked so the durability decisions — read the write
// back before deleting anything, roll a half-written thread back, never sweep
// while a stream might still be running — can be driven directly.

const mocks = vi.hoisted(() => ({
  fetchThreads: vi.fn(),
  createMessage: vi.fn(),
  fetchMessages: vi.fn(),
  threadsState: {
    threads: {} as Record<string, unknown>,
    createThread: vi.fn(),
    deleteThread: vi.fn(),
    setCurrentThreadId: vi.fn(),
  },
  messagesState: {
    getMessages: vi.fn(),
    setMessages: vi.fn(),
  },
  appState: {
    busyThreads: {} as Record<string, boolean>,
    abortControllers: {} as Record<string, { abort: () => void }>,
    cancelToolCalls: {} as Record<string, () => void>,
    clearThreadState: vi.fn(),
  },
  overridesState: {
    forThread: vi.fn(() => ({}) as Record<string, unknown>),
    setForThread: vi.fn(),
    dropThread: vi.fn(),
  },
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    threads: () => ({ fetchThreads: mocks.fetchThreads }),
    messages: () => ({
      createMessage: mocks.createMessage,
      fetchMessages: mocks.fetchMessages,
    }),
  }),
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => mocks.threadsState },
}))
vi.mock('@/hooks/useMessages', () => ({
  useMessages: { getState: () => mocks.messagesState },
}))
vi.mock('@/hooks/useAppState', () => ({
  useAppState: { getState: () => mocks.appState },
}))
vi.mock('@/hooks/useModelOverrides', () => ({
  useModelOverrides: { getState: () => mocks.overridesState },
}))

import { useTemporaryChat } from '@/hooks/useTemporaryChat'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

const KEPT_ID = 'kept-1'

function seedTemporaryChat(
  overrides: {
    model?: unknown
    messages?: Array<Record<string, unknown>>
  } = {}
) {
  mocks.threadsState.threads = {
    [TEMPORARY_CHAT_ID]: {
      id: TEMPORARY_CHAT_ID,
      model: overrides.model ?? { id: 'gpt', provider: 'openai' },
      assistants: [{ id: 'assistant-1' }],
    },
  }
  mocks.messagesState.getMessages.mockReturnValue(
    overrides.messages ?? [
      {
        id: 'm1',
        thread_id: TEMPORARY_CHAT_ID,
        role: 'user',
        content: [{ type: 'text', text: { value: 'Hello world' } }],
      },
    ]
  )
}

/** The happy path every service returns success for. */
function seedDurableWrites() {
  mocks.threadsState.createThread.mockResolvedValue({
    id: KEPT_ID,
    model: { id: 'gpt', provider: 'openai' },
  })
  mocks.fetchThreads.mockResolvedValue([{ id: KEPT_ID }])
  mocks.createMessage.mockImplementation(async (m: unknown) => m)
  mocks.fetchMessages.mockResolvedValue([{ id: 'm1' }])
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.threadsState.threads = {}
  mocks.appState.busyThreads = {}
  mocks.appState.abortControllers = {}
  mocks.appState.cancelToolCalls = {}
  mocks.overridesState.forThread.mockReturnValue({})
  useTemporaryChat.setState({ epoch: 0, busy: false, leaving: false })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('keep — success', () => {
  it('persists, confirms, carries the title, and leaves the temporary chat intact', async () => {
    seedTemporaryChat()
    seedDurableWrites()

    const result = await useTemporaryChat.getState().keep()

    expect(result).toEqual({ ok: true, threadId: KEPT_ID })
    // Created through the normal store path, titled from the first user message.
    expect(mocks.threadsState.createThread).toHaveBeenCalledWith(
      { id: 'gpt', provider: 'openai' },
      'Hello world',
      { id: 'assistant-1' }
    )
    // Every message re-addressed to the new thread.
    expect(mocks.createMessage).toHaveBeenCalledTimes(1)
    expect(mocks.createMessage.mock.calls[0][0].thread_id).toBe(KEPT_ID)
    // Confirmed through the non-optimistic boundary.
    expect(mocks.fetchThreads).toHaveBeenCalled()
    expect(mocks.fetchMessages).toHaveBeenCalledWith(KEPT_ID)
    // Client cache of the kept thread updated...
    expect(mocks.messagesState.setMessages).toHaveBeenCalledWith(
      KEPT_ID,
      expect.any(Array)
    )
    // ...but the temporary chat is NOT swept yet, and the epoch has not moved.
    expect(mocks.messagesState.setMessages).not.toHaveBeenCalledWith(
      TEMPORARY_CHAT_ID,
      []
    )
    expect(mocks.threadsState.deleteThread).not.toHaveBeenCalledWith(
      TEMPORARY_CHAT_ID
    )
    expect(useTemporaryChat.getState().epoch).toBe(0)
    // The keep-driven navigation is allowed through the guard.
    expect(useTemporaryChat.getState().leaving).toBe(true)
    expect(useTemporaryChat.getState().busy).toBe(false)
  })

  it('finalizeKept bumps the epoch and sweeps every temporary store, after navigation', async () => {
    seedTemporaryChat()
    seedDurableWrites()
    await useTemporaryChat.getState().keep()

    useTemporaryChat.getState().finalizeKept()

    expect(useTemporaryChat.getState().epoch).toBe(1)
    expect(useTemporaryChat.getState().leaving).toBe(false)
    expect(mocks.messagesState.setMessages).toHaveBeenCalledWith(
      TEMPORARY_CHAT_ID,
      []
    )
    expect(mocks.appState.clearThreadState).toHaveBeenCalledWith(TEMPORARY_CHAT_ID)
    expect(mocks.overridesState.dropThread).toHaveBeenCalledWith(TEMPORARY_CHAT_ID)
    expect(mocks.threadsState.deleteThread).toHaveBeenCalledWith(TEMPORARY_CHAT_ID)
  })

  it('carries a sparse override set onto the kept thread', async () => {
    seedTemporaryChat()
    seedDurableWrites()
    mocks.overridesState.forThread.mockReturnValue({ temperature: 0.7 })

    await useTemporaryChat.getState().keep()

    expect(mocks.overridesState.setForThread).toHaveBeenCalledWith(
      KEPT_ID,
      'temperature',
      0.7
    )
  })
})

describe('keep — durable-write failures preserve the temporary chat', () => {
  it('refuses when there is no chat to copy', async () => {
    // threads is empty: no temporary chat, no model.
    const result = await useTemporaryChat.getState().keep()
    expect(result).toEqual({
      ok: false,
      reason: 'thread-not-created',
      detail: 'no chat',
    })
    expect(mocks.threadsState.createThread).not.toHaveBeenCalled()
    expect(useTemporaryChat.getState().leaving).toBe(false)
  })

  it('refuses — and rolls the thread back — when the thread is not durable', async () => {
    seedTemporaryChat()
    mocks.threadsState.createThread.mockResolvedValue({ id: KEPT_ID })
    // The read-back does not contain the thread: the write did not land.
    mocks.fetchThreads.mockResolvedValue([{ id: 'someone-else' }])

    const result = await useTemporaryChat.getState().keep()

    expect(result).toEqual({
      ok: false,
      reason: 'thread-not-created',
      detail: 'not durable',
    })
    // No message was ever addressed to a thread we could not confirm.
    expect(mocks.createMessage).not.toHaveBeenCalled()
    // The half-created thread is rolled back and we are put back on the temp chat.
    expect(mocks.threadsState.deleteThread).toHaveBeenCalledWith(KEPT_ID)
    expect(mocks.threadsState.setCurrentThreadId).toHaveBeenCalledWith(
      TEMPORARY_CHAT_ID
    )
    // The temporary source is untouched.
    expect(mocks.messagesState.setMessages).not.toHaveBeenCalledWith(
      TEMPORARY_CHAT_ID,
      []
    )
    expect(useTemporaryChat.getState().leaving).toBe(false)
  })

  it('handles partial permanent data: thread durable, messages not', async () => {
    seedTemporaryChat()
    mocks.threadsState.createThread.mockResolvedValue({ id: KEPT_ID })
    mocks.fetchThreads.mockResolvedValue([{ id: KEPT_ID }])
    mocks.createMessage.mockImplementation(async (m: unknown) => m)
    // The read-back is missing the message: the write was swallowed.
    mocks.fetchMessages.mockResolvedValue([])

    const result = await useTemporaryChat.getState().keep()

    expect(result).toEqual({ ok: false, reason: 'messages-not-persisted' })
    // The orphan thread (a real thread with no conversation) is deleted...
    expect(mocks.threadsState.deleteThread).toHaveBeenCalledWith(KEPT_ID)
    // ...and never the temporary chat.
    expect(mocks.threadsState.deleteThread).not.toHaveBeenCalledWith(
      TEMPORARY_CHAT_ID
    )
    expect(useTemporaryChat.getState().leaving).toBe(false)
  })

  it('rolls back and reports when a write throws', async () => {
    seedTemporaryChat()
    mocks.threadsState.createThread.mockResolvedValue({ id: KEPT_ID })
    mocks.fetchThreads.mockResolvedValue([{ id: KEPT_ID }])
    mocks.createMessage.mockRejectedValue(new Error('disk full'))

    const result = await useTemporaryChat.getState().keep()

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'error', detail: 'disk full' })
    expect(mocks.threadsState.deleteThread).toHaveBeenCalledWith(KEPT_ID)
    expect(mocks.messagesState.setMessages).not.toHaveBeenCalledWith(
      TEMPORARY_CHAT_ID,
      []
    )
  })
})

describe('generation settlement', () => {
  it('aborts a keep when generation will not stop within the timeout', async () => {
    vi.useFakeTimers()
    seedTemporaryChat()
    seedDurableWrites()
    // Busy, and the abort does NOT clear it: the stream never settles.
    mocks.appState.busyThreads[TEMPORARY_CHAT_ID] = true
    mocks.appState.abortControllers[TEMPORARY_CHAT_ID] = { abort: vi.fn() }
    mocks.appState.cancelToolCalls[TEMPORARY_CHAT_ID] = vi.fn()

    const promise = useTemporaryChat.getState().keep()
    await vi.advanceTimersByTimeAsync(5100)
    const result = await promise

    expect(result).toEqual({ ok: false, reason: 'generation-not-stopped' })
    // Nothing was created while work might still produce late events.
    expect(mocks.threadsState.createThread).not.toHaveBeenCalled()
    expect(mocks.messagesState.setMessages).not.toHaveBeenCalledWith(
      TEMPORARY_CHAT_ID,
      []
    )
  })

  it('proceeds once the abort actually settles generation', async () => {
    vi.useFakeTimers()
    seedTemporaryChat()
    seedDurableWrites()
    mocks.appState.busyThreads[TEMPORARY_CHAT_ID] = true
    mocks.appState.abortControllers[TEMPORARY_CHAT_ID] = {
      abort: () => {
        mocks.appState.busyThreads[TEMPORARY_CHAT_ID] = false
      },
    }

    const promise = useTemporaryChat.getState().keep()
    await vi.advanceTimersByTimeAsync(200)
    const result = await promise

    expect(result).toEqual({ ok: true, threadId: KEPT_ID })
  })

  it('aborts a discard when generation will not stop, sweeping nothing', async () => {
    vi.useFakeTimers()
    seedTemporaryChat()
    mocks.appState.busyThreads[TEMPORARY_CHAT_ID] = true
    mocks.appState.abortControllers[TEMPORARY_CHAT_ID] = { abort: vi.fn() }

    const promise = useTemporaryChat.getState().discard()
    await vi.advanceTimersByTimeAsync(5100)
    const result = await promise

    expect(result).toEqual({ ok: false, reason: 'generation-not-stopped' })
    expect(mocks.messagesState.setMessages).not.toHaveBeenCalledWith(
      TEMPORARY_CHAT_ID,
      []
    )
    expect(useTemporaryChat.getState().epoch).toBe(0)
  })
})

describe('discard', () => {
  it('sweeps every temporary store and bumps the epoch', async () => {
    seedTemporaryChat()

    const result = await useTemporaryChat.getState().discard()

    expect(result).toEqual({ ok: true })
    expect(useTemporaryChat.getState().epoch).toBe(1)
    expect(mocks.messagesState.setMessages).toHaveBeenCalledWith(
      TEMPORARY_CHAT_ID,
      []
    )
    expect(mocks.appState.clearThreadState).toHaveBeenCalledWith(TEMPORARY_CHAT_ID)
    expect(mocks.overridesState.dropThread).toHaveBeenCalledWith(TEMPORARY_CHAT_ID)
    expect(mocks.threadsState.deleteThread).toHaveBeenCalledWith(TEMPORARY_CHAT_ID)
  })
})

describe('late events and reuse of TEMPORARY_CHAT_ID', () => {
  it('a captured epoch goes stale once the chat ends', async () => {
    const epochAtStart = useTemporaryChat.getState().epoch
    expect(useTemporaryChat.getState().isCurrentEpoch(epochAtStart)).toBe(true)

    seedTemporaryChat()
    await useTemporaryChat.getState().discard()

    // A late writer that captured the old epoch now knows to drop its write.
    expect(useTemporaryChat.getState().isCurrentEpoch(epochAtStart)).toBe(false)
    expect(
      useTemporaryChat.getState().isCurrentEpoch(useTemporaryChat.getState().epoch)
    ).toBe(true)
  })

  it('a second temporary chat under the same id sweeps cleanly and advances the epoch', async () => {
    seedTemporaryChat()
    await useTemporaryChat.getState().discard()
    expect(useTemporaryChat.getState().epoch).toBe(1)

    // The id is reused: a brand-new temporary chat, same TEMPORARY_CHAT_ID.
    seedTemporaryChat({ messages: [{ id: 'm2', thread_id: TEMPORARY_CHAT_ID }] })
    await useTemporaryChat.getState().discard()

    expect(useTemporaryChat.getState().epoch).toBe(2)
    // Swept again — nothing from the first chat is left to inherit.
    expect(
      mocks.threadsState.deleteThread.mock.calls.filter(
        (c) => c[0] === TEMPORARY_CHAT_ID
      ).length
    ).toBe(2)
  })
})

describe('re-entrancy guard', () => {
  it('refuses a keep while one is already running', async () => {
    useTemporaryChat.setState({ busy: true })
    const result = await useTemporaryChat.getState().keep()
    expect(result).toEqual({ ok: false, reason: 'error', detail: 'busy' })
  })

  it('refuses a discard while one is already running', async () => {
    useTemporaryChat.setState({ busy: true })
    const result = await useTemporaryChat.getState().discard()
    expect(result).toEqual({ ok: false, reason: 'busy' })
  })
})
