import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  createRoom: vi.fn(async (_i: unknown) => ({ id: 'r-new' })),
  updateRoomSettings: vi.fn(async (_r: unknown, _p: unknown) => ({ id: 'r1' })),
  deleteRoom: vi.fn(async () => {}),
  deleteCoworkSession: vi.fn(),
  stop: vi.fn(),
  deleteThread: vi.fn(),
  busy: {} as Record<string, boolean>,
}))

vi.mock('@/lib/rooms/controller', () => ({
  roomController: {
    createRoom: h.createRoom,
    updateRoomSettings: h.updateRoomSettings,
    deleteRoom: h.deleteRoom,
  },
}))
vi.mock('@/lib/rooms/persistence', () => ({
  getRoomPersistence: () => ({ getRoom: async () => ({ room: { id: 'r1' } }) }),
}))
vi.mock('@/lib/coworkSessionLifecycle', () => ({ deleteCoworkSession: h.deleteCoworkSession }))
vi.mock('@/hooks/useCoworkSessions', () => ({ useCoworkSessions: { getState: () => ({}) } }))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => ({ deleteThread: h.deleteThread }) },
}))
vi.mock('@/hooks/useAppState', () => ({
  useAppState: { getState: () => ({ busyThreads: h.busy }) },
}))
vi.mock('../composer', () => ({ composerFor: () => ({ stop: h.stop }) }))

import { handleMobileMutation } from '../mobileMutations'

describe('handleMobileMutation privilege limits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.busy = {}
  })

  it('room.update strips folder and participant toolAccess', async () => {
    await handleMobileMutation({
      mobileOp: 'room.update',
      id: 'r1',
      patch: {
        title: 'T',
        folder: 'C:/secret',
        extra: 1,
        participants: [{ id: 'p1', toolAccess: 'edit', model: { provider: 'a', id: 'b' } }],
      },
    })
    const patch = h.updateRoomSettings.mock.calls[0][1] as Record<string, unknown>
    expect(patch).toEqual({
      title: 'T',
      participants: [{ id: 'p1', model: { provider: 'a', id: 'b' } }],
    })
  })

  it('room.create ignores extra fields and forces toolAccess none', async () => {
    await handleMobileMutation({
      mobileOp: 'room.create',
      input: {
        title: 'R',
        folder: 'C:/x',
        bogus: true,
        participants: [{ name: 'A', model: { provider: 'a', id: 'b' }, toolAccess: 'edit' }],
      },
    })
    const input = h.createRoom.mock.calls[0][0] as Record<string, unknown>
    expect(input.folder).toBeUndefined()
    expect(input.bogus).toBeUndefined()
    expect(input.participants).toEqual([
      { name: 'A', model: { provider: 'a', id: 'b' }, toolAccess: 'none' },
    ])
  })

  it('thread.delete stops a busy run first; cowork.delete uses the lifecycle', async () => {
    h.busy = { t1: true }
    await handleMobileMutation({ mobileOp: 'thread.delete', id: 't1' })
    expect(h.stop).toHaveBeenCalled()
    expect(h.deleteThread).toHaveBeenCalledWith('t1')
    await handleMobileMutation({ mobileOp: 'cowork.delete', id: 's1' })
    expect(h.deleteCoworkSession).toHaveBeenCalledWith('s1')
  })
})
