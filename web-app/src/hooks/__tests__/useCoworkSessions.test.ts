import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useCoworkSessions } from '../useCoworkSessions'
import { accessOf } from '@/lib/coworkAccess'
import type { CoworkTurn, SubagentRun } from '@/types/coworkSession'

const reset = () =>
  useCoworkSessions.setState({ sessions: [], currentId: null })

const sub = (runId: string, name: string): SubagentRun => ({
  runId,
  name,
  status: 'done',
  startedAt: 0,
  turns: [],
})

describe('useCoworkSessions', () => {
  beforeEach(reset)

  it('starts a session with an empty message list', () => {
    const id = useCoworkSessions.getState().createSession()
    const s = useCoworkSessions.getState().sessions.find((x) => x.id === id)!
    expect(s.messages).toEqual([])
    expect(s.folder).toBeNull()
  })

  it('rewinds a run back to the question that started it', () => {
    const id = useCoworkSessions.getState().createSession()
    const turns: CoworkTurn[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'second' },
      { role: 'tool', content: '', name: 'read', status: 'done' },
      { role: 'assistant', content: 'answer' },
    ]
    const msgs = [
      { id: 'm1', role: 'user', parts: [] },
      { id: 'm2', role: 'assistant', parts: [] },
      { id: 'm3', role: 'user', parts: [] },
      { id: 'm4', role: 'assistant', parts: [] },
    ] as never
    useCoworkSessions.getState().commitTurns(id, turns, msgs, [])
    useCoworkSessions.getState().rewindToLastUser(id)

    const s = useCoworkSessions.getState().sessions.find((x) => x.id === id)!
    // The question survives; the chain of tool calls it produced does not.
    expect(s.turns.map((t) => t.content)).toEqual(['first', 'done', 'second'])
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  // Rewinding a session that has never had a turn would otherwise empty it.
  it('leaves a session with no user turn alone', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().rewindToLastUser(id)
    const s = useCoworkSessions.getState().sessions.find((x) => x.id === id)!
    expect(s.turns).toEqual([])
    expect(s.messages).toEqual([])
  })

  it('appends turns and replaces the message list on commit', () => {
    const id = useCoworkSessions.getState().createSession()
    const turn: CoworkTurn = { role: 'user', content: 'hi' }
    const msgs = [{ id: 'm1', role: 'user', parts: [] }] as never
    useCoworkSessions.getState().commitTurns(id, [turn], msgs, [])
    useCoworkSessions.getState().commitTurns(id, [turn], msgs, [])
    const s = useCoworkSessions.getState().sessions.find((x) => x.id === id)!
    expect(s.turns).toHaveLength(2)
    expect(s.messages).toHaveLength(1)
  })

  // A later run that dispatches no subagents must not erase what an earlier
  // run in the same session already finished.
  it('merges subagents by runId across runs instead of replacing', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().commitTurns(id, [], [], [sub('r1', 'alpha')])
    useCoworkSessions.getState().commitTurns(id, [], [], [])
    let s = useCoworkSessions.getState().sessions.find((x) => x.id === id)!
    expect(s.subagents?.map((r) => r.runId)).toEqual(['r1'])

    useCoworkSessions.getState().commitTurns(id, [], [], [sub('r1', 'renamed')])
    s = useCoworkSessions.getState().sessions.find((x) => x.id === id)!
    expect(s.subagents).toHaveLength(1)
    expect(s.subagents?.[0].name).toBe('renamed')
  })

  it('keeps the last usage when a run reports none', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions
      .getState()
      .commitTurns(id, [], [], [], { total_tokens: 42 })
    useCoworkSessions.getState().commitTurns(id, [], [], [])
    const s = useCoworkSessions.getState().sessions.find((x) => x.id === id)!
    expect(s.lastUsage?.total_tokens).toBe(42)
  })

  it('clears the transcript, messages and subagents together', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions
      .getState()
      .commitTurns(
        id,
        [{ role: 'user', content: 'hi' }],
        [{ id: 'm1', role: 'user', parts: [] }] as never,
        [sub('r1', 'alpha')],
        { total_tokens: 1 }
      )
    useCoworkSessions.getState().clearSession(id)
    const s = useCoworkSessions.getState().sessions.find((x) => x.id === id)!
    expect(s.turns).toEqual([])
    expect(s.messages).toEqual([])
    expect(s.subagents).toEqual([])
    expect(s.lastUsage).toBeUndefined()
  })

  it('sets a mode and detaches a folder', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().setMode(id, 'review')
    useCoworkSessions.getState().setFolder(id, '/tmp/project')
    let s = useCoworkSessions.getState().sessions.find((x) => x.id === id)!
    expect(s.mode).toBe('review')
    expect(s.folder).toBe('/tmp/project')

    useCoworkSessions.getState().setFolder(id, null)
    s = useCoworkSessions.getState().sessions.find((x) => x.id === id)!
    expect(s.folder).toBeNull()
  })
})

describe('useCoworkSessions persist migration', () => {
  // v0 sessions carry `turns` but no `messages`. Losing the tool turns on
  // upgrade would leave the agent replaying a conversation with holes in it.
  it('rebuilds messages from turns for a v0 session', () => {
    const migrate = useCoworkSessions.persist.getOptions().migrate!
    const out = migrate(
      {
        sessions: [
          {
            id: 's1',
            turns: [
              { role: 'user', content: 'build it' },
              {
                role: 'tool',
                content: '',
                name: 'write',
                callId: 'c1',
                args: { path: 'a.txt' },
                result: 'Created a.txt (3 bytes)',
                status: 'done',
              },
            ],
          },
        ],
      },
      0
    ) as { sessions: Array<{ messages: unknown[] }> }

    const parts = (out.sessions[0].messages as never[]).flatMap(
      (m: { parts?: unknown[] }) => m.parts ?? []
    )
    expect(out.sessions[0].messages.length).toBeGreaterThan(0)
    expect(parts.some((p: { type?: string }) => p.type === 'tool-write')).toBe(
      true
    )
  })

  it('leaves an already-migrated session alone', () => {
    const migrate = useCoworkSessions.persist.getOptions().migrate!
    const existing = [{ id: 's1', turns: [], messages: [{ id: 'keep' }] }]
    const out = migrate({ sessions: existing }, 1) as {
      sessions: Array<{ messages: Array<{ id: string }> }>
    }
    expect(out.sessions[0].messages[0].id).toBe('keep')
  })
})

/**
 * Attaching a repository is the moment the session gains something it can
 * damage, so it is the moment the mode has to be decided — not the first time
 * the user notices a file changed.
 */
describe('the mode a repository-bound session starts in', () => {
  const sessionOf = (id: string) =>
    useCoworkSessions.getState().sessions.find((x) => x.id === id)!

  it('is ask when a repository is attached to a fresh session', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().setFolder(id, '/home/dev/project')

    expect(sessionOf(id).mode).toBe('ask')
  })

  it('leaves a session with no repository alone', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().setFolder(id, null)

    expect(sessionOf(id).mode).toBeUndefined()
  })

  it('does not overrule a mode the user already chose', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().setMode(id, 'auto')
    useCoworkSessions.getState().setFolder(id, '/home/dev/project')

    expect(sessionOf(id).mode).toBe('auto')
  })

  // A session that has already run is not a first turn, and quietly turning it
  // read-only mid-conversation would strand work in progress.
  it('does not change a session that has already run', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().commitTurns(
      id,
      [{ role: 'assistant', content: 'done' } as never],
      [],
      []
    )
    useCoworkSessions.getState().setFolder(id, '/home/dev/project')

    expect(sessionOf(id).mode).toBeUndefined()
  })

  it('clears the legacy flag when a mode is chosen, so the two cannot disagree', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.setState((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, planMode: true } : x
      ),
    }))

    useCoworkSessions.getState().setMode(id, 'auto')

    expect(sessionOf(id).mode).toBe('auto')
    expect(sessionOf(id).planMode).toBeUndefined()
  })
})

/**
 * Access is granted, never inherited.
 *
 * Every path that could leave a session able to write somewhere the user did
 * not agree to is closed here: a session that predates access modes, a folder
 * that was swapped, and consent that named a different repository.
 */
describe('what a session may write to', () => {
  const sessionOf = (id: string) =>
    useCoworkSessions.getState().sessions.find((x) => x.id === id)!

  it('is nothing but the sandbox until told otherwise', () => {
    const id = useCoworkSessions.getState().createSession()

    expect(sessionOf(id).access).toBeUndefined()
    expect(accessOf(sessionOf(id))).toBe('review-only')
  })

  it('keeps an access mode the user chose', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().setFolder(id, '/home/dev/obs-forwarder')
    useCoworkSessions.getState().setAccess(id, 'edit-folder')

    expect(accessOf(sessionOf(id))).toBe('edit-folder')
  })

  it('records consent against the session and folder it was given for', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().setFolder(id, '/home/dev/obs-forwarder')
    useCoworkSessions.getState().grantEditConsent(id, '/home/dev/obs-forwarder')

    expect(sessionOf(id).editConsent).toEqual({
      sessionId: id,
      folder: '/home/dev/obs-forwarder',
    })
  })

  // Swapping the repository withdraws everything agreed about the old one.
  it('returns to review only when the folder changes', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().setFolder(id, '/home/dev/obs-forwarder')
    useCoworkSessions.getState().setAccess(id, 'edit-folder')
    useCoworkSessions.getState().grantEditConsent(id, '/home/dev/obs-forwarder')

    useCoworkSessions.getState().setFolder(id, '/home/dev/note-py')

    expect(accessOf(sessionOf(id))).toBe('review-only')
    expect(sessionOf(id).editConsent).toBeUndefined()
  })

  it('returns to review only when the folder is detached', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().setFolder(id, '/home/dev/obs-forwarder')
    useCoworkSessions.getState().setAccess(id, 'edit-folder')
    useCoworkSessions.getState().grantEditConsent(id, '/home/dev/obs-forwarder')

    useCoworkSessions.getState().setFolder(id, null)

    expect(accessOf(sessionOf(id))).toBe('review-only')
    expect(sessionOf(id).editConsent).toBeUndefined()
  })

  it('leaves both alone when the same folder is set again', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().setFolder(id, '/home/dev/obs-forwarder')
    useCoworkSessions.getState().setAccess(id, 'edit-folder')
    useCoworkSessions.getState().grantEditConsent(id, '/home/dev/obs-forwarder')

    useCoworkSessions.getState().setFolder(id, '/home/dev/obs-forwarder')

    expect(accessOf(sessionOf(id))).toBe('edit-folder')
    expect(sessionOf(id).editConsent).toBeDefined()
  })
})
