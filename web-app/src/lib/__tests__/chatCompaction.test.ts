import { describe, it, expect, vi } from 'vitest'
import type { UIMessage } from 'ai'

const threads: Record<string, { id: string; metadata?: Record<string, unknown> }> = {}
const updateThread = vi.fn((id: string, updates: { metadata?: Record<string, unknown> }) => {
  threads[id] = { ...threads[id], ...updates }
})
vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => ({ threads, updateThread }) },
}))

import {
  applyChatCompaction,
  readChatCompaction,
  registerChatCompactor,
  requestChatCompaction,
  stateAfter,
  writeChatCompaction,
} from '../chatCompaction'
import { compactHistory, isSummaryMessage } from '../compaction'
import { roomCompactionSettingsFor } from '../rooms/compactionSettings'

const text = (id: string, role: UIMessage['role'], body: string): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text: body }] }) as UIMessage

const chat = (turns: number): UIMessage[] =>
  Array.from({ length: turns }, (_, i) => [
    text(`u${i}`, 'user', `question ${i}`),
    text(`a${i}`, 'assistant', `answer ${i}`),
  ]).flat()

describe('chat compaction kept with the thread', () => {
  it('persists in thread metadata and is reused after a restart', async () => {
    threads.t1 = { id: 't1', metadata: { project: 'p' } }
    const messages = chat(6)
    const result = (await compactHistory(messages, {
      summarize: async () => 'gist',
      keepRecent: 2,
      reason: 'threshold',
    }))!
    const state = stateAfter(result.messages, result.record, result.latestRequest)!
    expect(state.boundaryId).toBe('u5')
    writeChatCompaction('t1', state)
    // Other metadata is kept.
    expect(threads.t1.metadata).toMatchObject({ project: 'p', compaction: state })

    // "Restart": the state comes back from the thread, not from memory.
    const restored = readChatCompaction('t1')!
    const summarize = vi.fn()
    const { history, stale } = applyChatCompaction([...messages, text('u6', 'user', 'next')], restored)
    expect(stale).toBe(false)
    expect(summarize).not.toHaveBeenCalled()
    expect(isSummaryMessage(history[0])).toBe(true)
    expect(history.slice(1).map((m) => m.id)).toEqual(['u5', 'a5', 'u6'])
  })

  it('is stale once its boundary message is gone, and can be cleared', () => {
    threads.t2 = { id: 't2' }
    writeChatCompaction('t2', {
      record: { summarizedCount: 2, summary: 's', at: 1, reason: 'manual' },
      boundaryId: 'gone',
      latestRequest: null,
    })
    expect(applyChatCompaction(chat(2), readChatCompaction('t2')).stale).toBe(true)
    writeChatCompaction('t2', null)
    expect(readChatCompaction('t2')).toBeNull()
  })

  it('keeps an unsaved thread in memory', () => {
    const state = {
      record: { summarizedCount: 1, summary: 's', at: 1, reason: 'manual' as const },
      boundaryId: 'x',
      latestRequest: null,
    }
    writeChatCompaction('temp', state)
    expect(readChatCompaction('temp')).toEqual(state)
  })

  it('routes /compact to the open conversation', () => {
    const fn = vi.fn(async () => {})
    const off = registerChatCompactor('t3', fn)
    expect(requestChatCompaction('t3')).toBe(true)
    expect(fn).toHaveBeenCalled()
    off()
    expect(requestChatCompaction('t3')).toBe(false)
  })
})

describe('room compaction settings per participant', () => {
  const lookup = (settings: Record<string, unknown>) => () =>
    ({ models: [{ id: 'm', settings }] }) as never

  it("uses the participant model's own switches and window", () => {
    const s = roomCompactionSettingsFor(
      { provider: 'p', id: 'm' },
      lookup({
        auto_compact: { controller_props: { value: false } },
        max_context_tokens: { controller_props: { value: 64000 } },
      }),
      { auto: true }
    )
    expect(s).toEqual({ enabled: false, window: 64000 })
  })

  it('falls back to the policy and the known window', () => {
    const s = roomCompactionSettingsFor({ provider: 'p', id: 'm' }, lookup({}), {
      auto: false,
    })
    expect(s).toEqual({ enabled: false, window: null })
    expect(
      roomCompactionSettingsFor({ provider: 'p', id: 'm' }, lookup({}), { auto: true })
        .enabled
    ).toBe(true)
  })
})
