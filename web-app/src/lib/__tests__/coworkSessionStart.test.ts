import { describe, expect, it } from 'vitest'
import {
  decideSessionStart,
  isSessionEmpty,
} from '@/lib/coworkSessionStart'
import type { CoworkSession } from '@/hooks/useCoworkSessions'

/**
 * "New session" used to create one every time it was pressed, including on a
 * session that was already blank. These are the rules that stopped that.
 */

const session = (over: Partial<CoworkSession> = {}): CoworkSession =>
  ({
    id: 's1',
    title: 'New session',
    folder: null,
    turns: [],
    messages: [],
    updated: 0,
    ...over,
  }) as CoworkSession

const decide = (over: {
  current?: CoworkSession | undefined
  running?: boolean
  hasDraft?: boolean
}) =>
  decideSessionStart({
    current: 'current' in over ? over.current : session(),
    running: over.running ?? false,
    hasDraft: over.hasDraft ?? false,
  })

describe('what counts as an empty session', () => {
  it('a session nothing has happened in', () => {
    expect(isSessionEmpty(session())).toBe(true)
  })

  it('not one with a transcript', () => {
    expect(
      isSessionEmpty(session({ turns: [{ role: 'user' }] as never }))
    ).toBe(false)
  })

  it('not one the model has been sent messages for', () => {
    expect(
      isSessionEmpty(session({ messages: [{ id: 'm' }] as never }))
    ).toBe(false)
  })

  it('not one with a todo list', () => {
    expect(
      isSessionEmpty(
        session({ todos: { phases: [{ tasks: [] }] } as never })
      )
    ).toBe(false)
  })

  it('not one where files were opened', () => {
    // Opening files is work, even with no turn run.
    expect(
      isSessionEmpty(
        session({ codePanel: { tabs: [{ path: 'a.ts' }] } as never })
      )
    ).toBe(false)
  })

  it('treats a missing session as empty', () => {
    expect(isSessionEmpty(undefined)).toBe(true)
  })
})

describe('pressing New session', () => {
  it('does nothing on a session that is already blank', () => {
    expect(decide({})).toBe('reuse')
  })

  it('twice in a row still does nothing', () => {
    // The second press sees the same blank session as the first.
    expect(decide({})).toBe('reuse')
    expect(decide({})).toBe('reuse')
  })

  it('creates one when the session has a transcript', () => {
    expect(decide({ current: session({ turns: [{}] as never }) })).toBe(
      'create'
    )
  })

  it('creates one when there is no session at all', () => {
    expect(decide({ current: undefined })).toBe('create')
  })

  it('creates one while a run is in flight, which is content too', () => {
    expect(decide({ running: true })).toBe('create')
  })
})

describe('an unsent draft', () => {
  it('keeps the user where they are, blank session or not', () => {
    // The composer is shared between sessions: starting a new one would
    // either strand the text or carry it somewhere it was not typed.
    expect(decide({ hasDraft: true })).toBe('reuse')
  })

  it('outranks a session that has content', () => {
    expect(
      decide({ current: session({ turns: [{}] as never }), hasDraft: true })
    ).toBe('reuse')
  })

  it('outranks a run in flight', () => {
    expect(decide({ running: true, hasDraft: true })).toBe('reuse')
  })
})
