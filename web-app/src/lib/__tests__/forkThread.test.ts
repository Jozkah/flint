import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadMessage } from '@janhq/core'

const threadsState = vi.hoisted(() => ({
  threads: {} as Record<string, unknown>,
  createThread: vi.fn(),
  updateThread: vi.fn(),
}))
const messagesState = vi.hoisted(() => ({
  all: [] as unknown[],
  addMessage: vi.fn(),
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => threadsState },
}))
vi.mock('@/hooks/useMessages', () => ({
  useMessages: {
    getState: () => ({ getMessages: () => messagesState.all, addMessage: messagesState.addMessage }),
  },
}))

import { ForkBranchError, forkThread, forkTitle, messagesToFork } from '../forkThread'

const msg = (id: string, role: string, extra: Record<string, unknown> = {}, parent?: string | null) =>
  ({
    id,
    thread_id: 't1',
    role,
    content: [{ type: 'text', text: { value: id, annotations: [] } }],
    created_at: 1,
    metadata: { ...(parent !== undefined ? { parentId: parent } : {}), ...extra },
  }) as unknown as ThreadMessage

beforeEach(() => {
  threadsState.threads = {
    t1: {
      id: 't1',
      title: 'Cache bug',
      model: { id: 'm', provider: 'p' },
      assistants: [{ id: 'jan', name: 'Flint' }],
      metadata: { folders: ['C:/work'], project: { id: 'p1', name: 'proj', updated_at: 1 }, hasDocuments: true, jevRoutedMessageId: 'a' },
    },
  }
  threadsState.createThread.mockReset().mockResolvedValue({ id: 'fork1', metadata: {} })
  threadsState.updateThread.mockReset()
  messagesState.addMessage.mockReset()
  messagesState.all = [
    msg('u1', 'user', {}, null),
    msg('a1', 'assistant', { usage: { totalTokens: 9 } }, 'u1'),
    msg('u2', 'user', {}, 'a1'),
    msg('a2', 'assistant', {}, 'u2'),
  ]
})

describe('forkTitle', () => {
  it('marks a fork once, however often it is forked again', () => {
    expect(forkTitle('Cache bug')).toBe('Cache bug (fork)')
    expect(forkTitle('Cache bug (fork)')).toBe('Cache bug (fork)')
    expect(forkTitle(undefined)).toBe('New Thread (fork)')
  })
})

describe('messagesToFork', () => {
  it('copies the shown branch only, not the versions of an edited message', () => {
    const edited = [...(messagesState.all as ThreadMessage[]), msg('u2b', 'user', {}, 'a1')]
    // u2b is a newer sibling of u2 under a1, so it is the branch shown.
    const ids = messagesToFork(
      edited.map((m, i) => ({ ...m, created_at: i + 1 }) as ThreadMessage)
    ).map((m) => m.id)
    expect(ids).toEqual(['u1', 'a1', 'u2b'])
  })

  it('stops after the chosen message', () => {
    expect(messagesToFork(messagesState.all as ThreadMessage[], 'a1').map((m) => m.id)).toEqual([
      'u1',
      'a1',
    ])
  })

  // C019: never fall back silently to another branch.
  it('refuses a message that is not on the shown branch', () => {
    expect(() => messagesToFork(messagesState.all as ThreadMessage[], 'nope')).toThrow(
      ForkBranchError
    )
  })

  // C019: an edited first message makes two roots; the thread's activeRootId
  // says which one the user is viewing, and the fork must copy that one.
  it('copies the root branch the thread has selected, not the newest', () => {
    const all = [
      msg('u1', 'user', {}, null),
      msg('a1', 'assistant', {}, 'u1'),
      msg('u1b', 'user', {}, null),
      msg('a1b', 'assistant', {}, 'u1b'),
    ].map((m, i) => ({ ...m, created_at: i + 1 }) as ThreadMessage)
    expect(messagesToFork(all, 'a1', { activeRootId: 'u1' }).map((m) => m.id)).toEqual([
      'u1',
      'a1',
    ])
    expect(() => messagesToFork(all, 'a1')).toThrow(ForkBranchError)
  })
})

describe('forkThread', () => {
  it('creates the copy with the same model, assistant, project and folders', async () => {
    const id = await forkThread('t1', 'a1')
    expect(id).toBe('fork1')
    const [model, title, assistant, project] = threadsState.createThread.mock.calls[0]
    expect(model).toEqual({ id: 'm', provider: 'p' })
    expect(title).toBe('Cache bug (fork)')
    expect(assistant).toMatchObject({ id: 'jan' })
    expect(project).toMatchObject({ id: 'p1' })
    const update = threadsState.updateThread.mock.calls[0][1]
    expect(update.metadata.folders).toEqual(['C:/work'])
    // Documents were embedded for the original chat; the copy does not claim them.
    expect(update.metadata.hasDocuments).toBeUndefined()
    expect(update.metadata.jevRoutedMessageId).toBeUndefined()
  })

  it('copies the messages under new ids in the new thread, without branch links', async () => {
    await forkThread('t1', 'a1')
    const copies = messagesState.addMessage.mock.calls.map((c) => c[0])
    expect(copies).toHaveLength(2)
    expect(copies.every((c) => c.thread_id === 'fork1')).toBe(true)
    expect(copies.map((c) => c.id)).not.toContain('u1')
    expect(new Set(copies.map((c) => c.id)).size).toBe(2)
    expect(copies[0].metadata.parentId).toBeUndefined()
    // Other metadata, such as usage, is kept.
    expect(copies[1].metadata.usage).toEqual({ totalTokens: 9 })
  })

  it('forks the branch the thread has selected', async () => {
    messagesState.all = [
      msg('u1', 'user', {}, null),
      msg('a1', 'assistant', {}, 'u1'),
      msg('u1b', 'user', {}, null),
      msg('a1b', 'assistant', {}, 'u1b'),
    ].map((m, i) => ({ ...m, created_at: i + 1 }) as ThreadMessage)
    ;(threadsState.threads.t1 as { metadata: Record<string, unknown> }).metadata.activeRootId = 'u1'
    await forkThread('t1', 'a1')
    const copied = messagesState.addMessage.mock.calls.map(
      (c) => (c[0].content[0] as { text: { value: string } }).text.value
    )
    expect(copied).toEqual(['u1', 'a1'])
  })

  it('does not touch the original messages', async () => {
    await forkThread('t1')
    expect((messagesState.all as ThreadMessage[])[1].metadata).toMatchObject({ parentId: 'u1' })
  })

  it('refuses a temporary chat, an unknown chat, a chat with no model or no messages', async () => {
    expect(await forkThread('temporary-chat')).toBeNull()
    expect(await forkThread('missing')).toBeNull()
    threadsState.threads = { t2: { id: 't2', title: 'x', metadata: {} } }
    expect(await forkThread('t2')).toBeNull()
    threadsState.threads = { t1: { id: 't1', title: 'x', model: { id: 'm', provider: 'p' }, metadata: {} } }
    messagesState.all = []
    expect(await forkThread('t1')).toBeNull()
    expect(threadsState.createThread).not.toHaveBeenCalled()
  })
})

describe('forkThread message ids (T7-023)', () => {
  it('keeps the copied order when ids are created in one millisecond', async () => {
    messagesState.all = Array.from({ length: 50 }, (_, i) =>
      msg(`m${String(i).padStart(2, '0')}`, i % 2 ? 'assistant' : 'user', {}, i ? `m${String(i - 1).padStart(2, '0')}` : null)
    ).map((m, i) => ({ ...m, created_at: i + 1 }) as ThreadMessage)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      await forkThread('t1')
    } finally {
      now.mockRestore()
    }
    const added = messagesState.addMessage.mock.calls.map((c) => c[0] as ThreadMessage)
    expect(added.map((m) => m.metadata && (m.content[0] as { text: { value: string } }).text.value)).toEqual(
      messagesState.all.map((m) => (m as ThreadMessage).id)
    )
    const ids = added.map((m) => m.id)
    expect([...ids].sort()).toEqual(ids)
  })
})
