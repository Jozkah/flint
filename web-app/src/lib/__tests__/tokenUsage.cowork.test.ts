/**
 * Cowork's side of the cache breakdown: the runner's step fold, the run
 * outcome, and the session store across a restart. AH-211.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UIMessageChunk } from 'ai'

// An in-memory stand-in for the Rust settings store the session store
// persists to, so "restart" can be a real rehydrate from what was written.
const disk = vi.hoisted(() => new Map<string, string>())
vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn(async (key: string) => disk.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      disk.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      disk.delete(key)
    }),
  },
}))

import { consumeStep, runTurn, type ToolOutcome } from '../coworkRunner'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { localStorageKey } from '@/constants/localStorage'
import { fromCoworkUsage } from '@/lib/tokenUsage'
import type { SubagentRun } from '@/types/coworkSession'

const streamOf = (chunks: unknown[]): ReadableStream<UIMessageChunk> =>
  new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk as UIMessageChunk)
      c.close()
    },
  })

const finish = (usage: Record<string, unknown>) => ({
  type: 'finish',
  messageMetadata: { usage },
})

const sink = () => ({
  onText: vi.fn(),
  onToolStart: vi.fn(),
  onToolArgsDelta: vi.fn(),
  onToolCall: vi.fn(),
})

describe('Cowork runner', () => {
  it('folds a step with the cache breakdown the transport attached', async () => {
    const step = await consumeStep(
      streamOf([
        { type: 'text-delta', id: 't', delta: 'hi' },
        finish({
          inputTokens: 5974,
          outputTokens: 8,
          totalTokens: 5982,
          cachedInputTokens: 5957,
          uncachedInputTokens: 17,
          cacheSource: 'openai-chat',
        }),
      ]),
      sink()
    )
    expect(step.usage).toEqual({
      prompt_tokens: 5974,
      completion_tokens: 8,
      total_tokens: 5982,
      cached_prompt_tokens: 5957,
      uncached_prompt_tokens: 17,
      cache_source: 'openai-chat',
    })
  })

  it('never turns an unreported cache into a zero', async () => {
    const step = await consumeStep(
      streamOf([finish({ inputTokens: 6100, outputTokens: 3, totalTokens: 6103 })]),
      sink()
    )
    expect(step.usage).toEqual({
      prompt_tokens: 6100,
      completion_tokens: 3,
      total_tokens: 6103,
    })
  })

  it("reports the last step's breakdown for the run, not a sum of the steps", async () => {
    const steps = [
      [
        { type: 'tool-input-start', toolCallId: 'c1', toolName: 'ls' },
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'ls', input: {} },
        finish({ inputTokens: 1000, outputTokens: 10, totalTokens: 1010, cachedInputTokens: 0 }),
      ],
      [
        { type: 'text-delta', id: 't', delta: 'done' },
        finish({ inputTokens: 1100, outputTokens: 20, totalTokens: 1120, cachedInputTokens: 1010 }),
      ],
    ]
    let i = 0
    const onStep = vi.fn()
    const outcome = await runTurn({
      messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'go' }] } as never],
      signal: new AbortController().signal,
      deps: {
        sendStep: vi.fn(async () => streamOf(steps[i++])),
        dispatch: vi.fn(async (): Promise<ToolOutcome> => ({ output: 'ok' })),
        sink: sink(),
        onStep,
        nextMessageId: (() => {
          let n = 0
          return () => `m${n++}`
        })(),
      },
    })
    // Each step replays the conversation, so the latest request is what the
    // context holds now; its cache hit is its own.
    expect(outcome.usage).toMatchObject({
      prompt_tokens: 1100,
      cached_prompt_tokens: 1010,
      uncached_prompt_tokens: 90,
    })
    expect(onStep.mock.calls[0][0].result.usage).toMatchObject({
      cached_prompt_tokens: 0,
      uncached_prompt_tokens: 1000,
    })
  })
})

describe('Cowork session persistence', () => {
  beforeEach(() => {
    disk.clear()
    useCoworkSessions.setState({ sessions: [], currentId: null })
  })

  const subagent = (usage: SubagentRun['usage']): SubagentRun => ({
    runId: 'r1',
    name: 'researcher',
    status: 'done',
    startedAt: 0,
    turns: [],
    usage,
  })

  it('keeps the breakdown, and a subagent usage, across a restart', async () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().commitTurns(
      id,
      [{ role: 'user', content: 'hi' }],
      [],
      [subagent({ prompt_tokens: 900, completion_tokens: 40, total_tokens: 940, cached_prompt_tokens: 800, uncached_prompt_tokens: 100 })],
      {
        prompt_tokens: 5974,
        completion_tokens: 8,
        total_tokens: 5982,
        cached_prompt_tokens: 5957,
        uncached_prompt_tokens: 17,
        cache_source: 'openai-chat',
      }
    )
    // Let the async storage write land, then drop everything in memory. The
    // store writes on every change, so the wipe is written too; put back what
    // was on disk, which is what a restart would find.
    await vi.waitFor(() =>
      expect(disk.get(localStorageKey.coworkSessions)).toContain('cached_prompt_tokens')
    )
    const saved = disk.get(localStorageKey.coworkSessions)!
    useCoworkSessions.setState({ sessions: [], currentId: null })
    disk.set(localStorageKey.coworkSessions, saved)

    await useCoworkSessions.persist.rehydrate()

    const s = useCoworkSessions.getState().sessions.find((x) => x.id === id)!
    expect(fromCoworkUsage(s.lastUsage)).toEqual({
      inputTokens: 5974,
      outputTokens: 8,
      totalTokens: 5982,
      cachedInputTokens: 5957,
      uncachedInputTokens: 17,
      cacheSource: 'openai-chat',
    })
    expect(s.subagents?.[0].usage?.cached_prompt_tokens).toBe(800)
  })

  it('loads a session saved before cache fields existed without inventing them', async () => {
    disk.set(
      localStorageKey.coworkSessions,
      JSON.stringify({
        state: {
          sessions: [
            {
              id: 'old',
              title: 'Old',
              folder: null,
              turns: [],
              messages: [],
              lastUsage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
              codePanel: { tabs: [], activeTabId: null, expandedDirs: [], wordWrap: false },
              updated: 1,
            },
          ],
          currentId: 'old',
        },
        version: 4,
      })
    )
    await useCoworkSessions.persist.rehydrate()
    const s = useCoworkSessions.getState().sessions.find((x) => x.id === 'old')!
    expect(s.lastUsage).toEqual({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 })
    const usage = fromCoworkUsage(s.lastUsage)
    expect(usage?.cachedInputTokens).toBeUndefined()
    expect(usage?.uncachedInputTokens).toBeUndefined()
  })
})
