import { describe, it, expect, vi, beforeEach } from 'vitest'

const stored = vi.hoisted(() => ({ value: null as string | null }))

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn(async () => stored.value),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}))

import { ensureCurrentSession, useCoworkSessions } from '../useCoworkSessions'
import type { CoworkSession } from '../useCoworkSessions'

const blank = (id: string): CoworkSession => ({
  id,
  title: 'New session',
  folder: null,
  turns: [],
  messages: [],
  updated: 1,
})

const used = (id: string): CoworkSession => ({
  ...blank(id),
  title: 'Fix the parser',
  turns: [{ role: 'user', content: 'fix it' }] as CoworkSession['turns'],
})

describe('empty Cowork sessions', () => {
  beforeEach(() => {
    stored.value = null
    useCoworkSessions.setState({ sessions: [], currentId: null })
  })

  it('drops blank sessions on load, keeping the current one and any with content', async () => {
    stored.value = JSON.stringify({
      state: {
        sessions: [blank('b1'), used('u1'), blank('b2'), blank('b3'), { ...blank('r1'), title: 'Renamed' }],
        currentId: 'b2',
      },
      version: 4,
    })
    await useCoworkSessions.persist.rehydrate()
    const ids = useCoworkSessions.getState().sessions.map((s) => s.id)
    expect(ids).toEqual(['u1', 'b2', 'r1'])
    expect(useCoworkSessions.getState().currentId).toBe('b2')
  })

  it('reuses a blank session when the selection points nowhere', () => {
    useCoworkSessions.setState({
      sessions: [used('u1'), blank('b1')],
      currentId: 'gone',
    })
    expect(ensureCurrentSession()).toBe('b1')
    expect(useCoworkSessions.getState().currentId).toBe('b1')
    expect(useCoworkSessions.getState().sessions).toHaveLength(2)
    // Asking again does not create another.
    expect(ensureCurrentSession()).toBe('b1')
    expect(useCoworkSessions.getState().sessions).toHaveLength(2)
  })

  it('creates a session only when no blank one exists', () => {
    useCoworkSessions.setState({ sessions: [used('u1')], currentId: null })
    const id = ensureCurrentSession()
    expect(id).not.toBe('u1')
    expect(useCoworkSessions.getState().sessions).toHaveLength(2)
  })
})
