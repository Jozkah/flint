/**
 * Portable sessions (AH-203): what an export carries, and how an import comes
 * back -- same order, same states, a new id, no authority, no duplicates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
}))

import {
  useCoworkSessions,
  type CoworkSession,
} from '@/hooks/useCoworkSessions'
import { useFileActivity } from '@/hooks/useFileActivity'
import { buildBundle, checkBundle, type SessionBundle } from '../sessionBundle'
import type { CoworkTurn } from '@/types/coworkSession'

const turns: CoworkTurn[] = [
  { role: 'user', content: 'plan my trip' },
  {
    role: 'tool',
    content: '',
    name: 'write',
    callId: 'c1',
    args: { path: 'plan.md' },
    diff: '+ day one\n+ day two\n- old',
    toolState: 'succeeded',
  } as CoworkTurn,
  {
    role: 'assistant',
    content: 'Which city?',
    asks: [
      {
        requestId: 'q1',
        request: { questions: [] },
        sessionId: 'orig',
        at: '2026-09-10T00:00:00Z',
        state: 'pending',
      },
    ],
  } as unknown as CoworkTurn,
]

const session = (over: Partial<CoworkSession> = {}): CoworkSession => ({
  id: 'orig',
  title: 'Trip',
  folder: 'C:/Users/someone/project',
  access: 'edit-folder',
  turns,
  messages: [],
  updated: 1,
  ...over,
})

const bundle = (): SessionBundle =>
  buildBundle({
    session: session(),
    toolActivity: [
      { call: 'c1', session: 'orig' } as never,
      { call: 'x', session: 'someone-else' } as never,
    ],
    fileActivity: [
      {
        id: 'f1',
        path: 'plan.md',
        operation: 'write',
        seq: 1,
        at: 1,
        ok: true,
        origin: { kind: 'sandbox', sessionKey: 'orig' },
      } as never,
    ],
    exportId: 'exp-1',
    now: new Date('2026-09-10T00:00:00Z'),
  })

beforeEach(() => {
  useCoworkSessions.setState({ sessions: [], currentId: null })
  useFileActivity.setState({ byConversation: {} } as never)
})

describe('buildBundle', () => {
  it('is versioned and self-describing', () => {
    const b = bundle()
    expect(b.format).toBe('jan.cowork-session')
    expect(b.schemaVersion).toBe(1)
    expect(checkBundle(b)).toBeNull()
  })

  it('carries the conversation, its questions and its change summary, and no authority', () => {
    const b = bundle()
    expect(b.session.turns).toHaveLength(3)
    expect(b.changeSummary).toEqual([
      { path: 'plan.md', additions: 2, deletions: 1 },
    ])
    const s = b.session as Record<string, unknown>
    expect(s.folder).toBeUndefined()
    expect(s.access).toBeUndefined()
    expect(s.messages).toBeUndefined()
  })

  it("carries only this session's tool activity", () => {
    expect(bundle().toolActivity.map((i) => i.call)).toEqual(['c1'])
  })
})

describe('importSession', () => {
  it('creates an unbound session with the same turns in the same order', () => {
    const out = useCoworkSessions.getState().importSession(bundle())
    expect(out.ok).toBe(true)
    const id = out.ok ? out.id : ''
    const s = useCoworkSessions.getState().sessions.find((x) => x.id === id)!
    expect(id).not.toBe('orig')
    expect(s.folder).toBeNull()
    expect(s.access).toBeUndefined()
    expect(s.turns.map((t) => t.role)).toEqual(['user', 'tool', 'assistant'])
    expect(s.turns[1].toolState).toBe('succeeded')
    expect(s.importedFrom).toMatchObject({
      exportId: 'exp-1',
      sessionId: 'orig',
    })
    expect(s.messages.length).toBeGreaterThan(0)
  })

  it('brings a question that was pending back as stale, under the new session', () => {
    const out = useCoworkSessions.getState().importSession(bundle())
    const id = out.ok ? out.id : ''
    const s = useCoworkSessions.getState().sessions.find((x) => x.id === id)!
    expect(s.turns[2].asks?.[0]).toMatchObject({
      state: 'stale',
      sessionId: id,
    })
  })

  it('re-keys file activity to the new session', () => {
    const out = useCoworkSessions.getState().importSession(bundle())
    const id = out.ok ? out.id : ''
    const events = useFileActivity.getState().eventsFor(id)
    expect(events).toHaveLength(1)
    expect((events[0].origin as { sessionKey?: string }).sessionKey).toBe(id)
  })

  it('refuses the same export twice, naming the session it became', () => {
    const first = useCoworkSessions.getState().importSession(bundle())
    const second = useCoworkSessions.getState().importSession(bundle())
    expect(second).toEqual({
      ok: false,
      refusal: {
        reason: 'already-imported',
        sessionId: first.ok ? first.id : '',
      },
    })
    expect(useCoworkSessions.getState().sessions).toHaveLength(1)
  })

  it('refuses a schema version it does not understand, and creates nothing', () => {
    const b = { ...bundle(), schemaVersion: 2 }
    const out = useCoworkSessions.getState().importSession(b)
    expect(out.ok).toBe(false)
    expect(!out.ok && out.refusal.reason).toBe('invalid')
    expect(useCoworkSessions.getState().sessions).toHaveLength(0)
  })
})

// AH-211: an exported session keeps the provider's usage, cache breakdown
// included; a hand-edited file cannot plant nonsense; an older file without
// usage imports with none rather than a zero.
describe('token usage across export and import', () => {
  beforeEach(() => useCoworkSessions.setState({ sessions: [], currentId: null }))

  const withUsage = (lastUsage: unknown) =>
    JSON.parse(
      JSON.stringify(
        buildBundle({
          session: session({
            lastUsage: lastUsage as CoworkSession['lastUsage'],
            subagents: [
              {
                runId: 'r1',
                name: 'researcher',
                status: 'done',
                startedAt: 0,
                turns: [],
                usage: {
                  prompt_tokens: 900,
                  completion_tokens: 40,
                  total_tokens: 940,
                  cached_prompt_tokens: 800,
                  uncached_prompt_tokens: 100,
                },
              },
            ],
          }),
          toolActivity: [],
          fileActivity: [],
        })
      )
    ) as SessionBundle

  it('keeps the session and subagent cache breakdown', () => {
    const usage = {
      prompt_tokens: 5900,
      completion_tokens: 32,
      total_tokens: 5932,
      cached_prompt_tokens: 5863,
      uncached_prompt_tokens: 37,
      cache_source: 'openai-chat' as const,
    }
    const result = useCoworkSessions.getState().importSession(withUsage(usage))
    expect(result.ok).toBe(true)
    const s = useCoworkSessions.getState().sessions[0]
    expect(s.lastUsage).toEqual(usage)
    expect(s.subagents?.[0].usage?.cached_prompt_tokens).toBe(800)
  })

  it('normalises an edited usage instead of trusting it', () => {
    useCoworkSessions.getState().importSession(
      withUsage({
        prompt_tokens: 100,
        completion_tokens: 1,
        total_tokens: 101,
        cached_prompt_tokens: 250,
        uncached_prompt_tokens: -5,
      })
    )
    const s = useCoworkSessions.getState().sessions[0]
    expect(s.lastUsage?.cached_prompt_tokens).toBe(100)
    expect(s.lastUsage?.uncached_prompt_tokens).toBe(0)
    expect(s.lastUsage?.reported).toEqual({ cachedInputTokens: 250 })
  })

  it('imports an older export without usage as no usage, not zero', () => {
    const legacy = withUsage(undefined)
    delete (legacy.session as { lastUsage?: unknown }).lastUsage
    useCoworkSessions.getState().importSession(legacy)
    expect(useCoworkSessions.getState().sessions[0].lastUsage).toBeUndefined()
  })
})
