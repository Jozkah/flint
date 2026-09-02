import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useCoworkSessions } from '../useCoworkSessions'
import { emptyCodePanelState } from '@/lib/coworkCode'

/**
 * The persisted blob is not a `CoworkSession[]` — that is the whole point of a
 * migration — so these fixtures stay loosely typed and go through `migrate`
 * exactly as they came off disk.
 */
type PersistedSession = Record<string, unknown>
type MigratedState = { sessions?: PersistedSession[] } | undefined

const migrate = (persisted: unknown, version: number): MigratedState =>
  (
    useCoworkSessions.persist.getOptions().migrate as unknown as (
      p: unknown,
      v: number
    ) => MigratedState
  )(persisted, version)

/** Deep clone, so an in-place mutation by `migrate` would be caught rather than
 * hidden by the fixture and the result sharing one object. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

// A complete v1 session: everything the shape allowed before `codePanel`.
const v1Session = {
  id: 's-v1',
  title: 'Refactor the parser',
  folder: '/Users/dev/project',
  turns: [
    { role: 'user', content: 'refactor the parser' },
    { role: 'assistant', content: 'done' },
  ],
  messages: [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'refactor it' }] },
    { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
  ],
  todos: {
    phases: [
      { name: 'Parse', tasks: [{ content: 'split lexer', status: 'completed' }] },
    ],
  },
  planMode: true,
  updated: 1717171717171,
}

// A v0 session: legacy `history`, a transcript that includes a tool turn, and
// no `messages` at all.
const v0Session = {
  id: 's-v0',
  title: 'Legacy session',
  folder: null,
  turns: [
    { role: 'user', content: 'build it' },
    { role: 'assistant', content: 'on it' },
    {
      role: 'tool',
      content: '',
      name: 'write',
      callId: 'c1',
      args: { path: 'a.txt' },
      result: 'Created a.txt (3 bytes)',
      status: 'done',
    },
    { role: 'assistant', content: 'created a.txt' },
  ],
  history: [
    { role: 'user', content: 'build it' },
    { role: 'assistant', content: 'created a.txt' },
  ],
  updated: 1600000000000,
}

describe('useCoworkSessions migrate: v1 -> v2', () => {
  it('gives a session with no code panel the empty code panel state', () => {
    const out = migrate({ sessions: [clone(v1Session)], currentId: 's-v1' }, 1)

    expect(out?.sessions?.[0].codePanel).toEqual({
      openPaths: [],
      activePath: null,
      expandedDirs: [],
      wordWrap: false,
    })
    // The store's own constructor is the contract; the literal above pins it.
    expect(out?.sessions?.[0].codePanel).toEqual(emptyCodePanelState())
  })

  it('passes every other field through byte-for-byte', () => {
    const out = migrate({ sessions: [clone(v1Session)] }, 1)
    const { codePanel: _codePanel, ...rest } = out!.sessions![0]

    expect(rest).toEqual(v1Session)
    // Byte-for-byte, not just deep-equal: no reordering, no coerced numbers.
    expect(JSON.stringify(rest)).toBe(JSON.stringify(v1Session))
  })

  it('leaves the v1 message list alone instead of rebuilding it', () => {
    const out = migrate({ sessions: [clone(v1Session)] }, 1)
    expect(out?.sessions?.[0].messages).toEqual(v1Session.messages)
  })

  it('keeps state outside `sessions` (currentId) untouched', () => {
    const out = migrate(
      { sessions: [clone(v1Session)], currentId: 's-v1' },
      1
    ) as { currentId?: string | null }
    expect(out.currentId).toBe('s-v1')
  })
})

describe('useCoworkSessions migrate: v0 -> v2', () => {
  it('rebuilds messages from turns and adds a code panel in one pass', () => {
    const out = migrate({ sessions: [clone(v0Session)] }, 0)
    const session = out!.sessions![0]
    const messages = session.messages as Array<{
      id: string
      role: string
      parts: Array<{ type: string; output?: string }>
    }>

    // Grouping: the user turn opens a message, the assistant/tool run that
    // follows folds into a single assistant message.
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[0].id).toBe('s-v0-user-0')

    // The tool turn — the thing the legacy `history` could not represent —
    // survives as a tool part carrying its output.
    const parts = messages.flatMap((m) => m.parts)
    const toolPart = parts.find((p) => p.type === 'tool-write')
    expect(toolPart).toBeDefined()
    expect(toolPart?.output).toBe('Created a.txt (3 bytes)')

    expect(session.codePanel).toEqual(emptyCodePanelState())
  })

  it('loses nothing: history, turns and scalars all survive', () => {
    const out = migrate({ sessions: [clone(v0Session)] }, 0)
    const session = out!.sessions![0]

    // `history` is read, never rewritten — a rollback still reads this blob.
    expect(session.history).toEqual(v0Session.history)
    expect(session.turns).toEqual(v0Session.turns)
    expect(session.id).toBe(v0Session.id)
    expect(session.title).toBe(v0Session.title)
    expect(session.folder).toBeNull()
    expect(session.updated).toBe(v0Session.updated)
  })

  it('keeps the turns array the same length and content', () => {
    const out = migrate({ sessions: [clone(v0Session)] }, 0)
    const turns = out!.sessions![0].turns as unknown[]

    expect(turns).toHaveLength(v0Session.turns.length)
    expect(JSON.stringify(turns)).toBe(JSON.stringify(v0Session.turns))
  })
})

describe('useCoworkSessions migrate: already at v2', () => {
  const populated = {
    ...v1Session,
    id: 's-v2',
    codePanel: {
      openPaths: ['src/main.ts', 'sandbox:notes.md'],
      activePath: 'sandbox:notes.md',
      expandedDirs: ['src', 'src/lib'],
      wordWrap: true,
    },
  }

  it('passes a populated code panel through untouched', () => {
    const out = migrate({ sessions: [clone(populated)] }, 2)
    const session = out!.sessions![0]

    expect(session.codePanel).toEqual(populated.codePanel)
    expect(
      (session.codePanel as { openPaths: string[] }).openPaths
    ).toEqual(['src/main.ts', 'sandbox:notes.md'])
    expect(
      (session.codePanel as { activePath: string }).activePath
    ).toBe('sandbox:notes.md')
    expect(session).toEqual(populated)
  })

  // The v1 -> v2 step is guarded on the field, not only on the version, so a
  // session that already has tabs must not be reset by a re-run.
  it('does not overwrite an existing code panel when re-run from v1', () => {
    const out = migrate({ sessions: [clone(populated)] }, 1)
    expect(out!.sessions![0].codePanel).toEqual(populated.codePanel)
  })

  it('migrates a mixed list, touching only the session that needs it', () => {
    const out = migrate(
      { sessions: [clone(populated), clone(v1Session)] },
      1
    )
    expect(out!.sessions![0].codePanel).toEqual(populated.codePanel)
    expect(out!.sessions![1].codePanel).toEqual(emptyCodePanelState())
    expect(out!.sessions).toHaveLength(2)
  })
})

describe('useCoworkSessions migrate: nothing to migrate', () => {
  it('handles an empty session list at every version', () => {
    for (const version of [0, 1, 2]) {
      expect(() => migrate({ sessions: [], currentId: null }, version)).not.toThrow()
      expect(migrate({ sessions: [], currentId: null }, version)).toEqual({
        sessions: [],
        currentId: null,
      })
    }
  })

  it('returns an absent session list unchanged instead of throwing', () => {
    expect(() => migrate({ currentId: null }, 0)).not.toThrow()
    expect(migrate({ currentId: null }, 0)).toEqual({ currentId: null })
  })

  it('survives an undefined persisted blob', () => {
    expect(() => migrate(undefined, 0)).not.toThrow()
    expect(migrate(undefined, 0)).toBeUndefined()
  })
})
