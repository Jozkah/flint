import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { adaptEngine, normalizeError, useRoomsApi } from '../roomsBindings'
import { makeRoom } from './roomsTestUtils'

function fakeStore(initial: Record<string, unknown>) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => {
      state = { ...state, ...patch }
      listeners.forEach((l) => l())
    },
    subscribe: (l: () => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
}

const controller = {
  start: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
  selectNext: vi.fn(),
  sendUserMessage: vi.fn(),
  callVote: vi.fn(),
  requestFinalPositions: vi.fn(),
  synthesize: vi.fn(),
  cancelTurn: vi.fn(),
}

describe('roomsBindings', () => {
  it('returns null when the engine exports are missing', () => {
    expect(adaptEngine({})).toBeNull()
  })

  it('adapts the engine store with a stable snapshot and forwards actions', async () => {
    const room = makeRoom()
    const loadRoom = vi.fn()
    const store = fakeStore({ summaries: [], room: null, journal: [], liveTurn: null, lastError: 'boom', loadRoom })
    const createRoom = vi.fn(async () => room)
    const api = adaptEngine({ useRoomsStore: store, roomController: controller, createRoom })!

    expect(api.status).toBe('ready')
    const a = api.getState()
    expect(api.getState()).toBe(a)
    expect(a.lastError).toEqual({ message: 'boom' })

    const listener = vi.fn()
    api.subscribe(listener)
    store.setState({ room, busy: true })
    expect(listener).toHaveBeenCalled()
    expect(api.getState()).not.toBe(a)
    expect(api.getState().room).toBe(room)
    expect(api.getState().pendingAction).toBe('busy')

    await api.loadRoom('r1')
    expect(loadRoom).toHaveBeenCalledWith('r1')
    await expect(api.createRoom({ title: 'x', objective: '' })).resolves.toBe(room)
    await expect(api.deleteRoom('r1')).rejects.toThrow(/deleteRoom/)
  })

  it('normalizes errors', () => {
    expect(normalizeError(null)).toBeNull()
    expect(normalizeError({ code: 'io', message: 'disk' })).toEqual({ code: 'io', message: 'disk' })
    expect(normalizeError(new Error('x'))).toEqual({ message: 'x' })
  })

  it('without a provider, resolves the engine lazily instead of staying pending', async () => {
    const { result } = renderHook(() => useRoomsApi())
    await waitFor(() => expect(result.current.status).not.toBe('pending'), {
      timeout: 15000,
    })
  })
})
