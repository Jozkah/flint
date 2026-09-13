import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))
import { invoke } from '@tauri-apps/api/core'
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

import {
  appendRoomRecord,
  deleteRoom,
  getRoom,
  isRoomErrorCode,
  listRooms,
  saveRoom,
  toRoomError,
} from '../rooms'
import {
  DEFAULT_ROOM_LIMITS,
  type Room,
  type RoomJournalRecord,
} from '@/lib/rooms/types'

const room: Room = {
  v: 1,
  id: 'r1',
  title: 'Room',
  objective: 'Decide',
  status: 'draft',
  mode: 'round-robin',
  moderator: { enabled: false, name: 'Moderator', model: null },
  participants: [],
  limits: DEFAULT_ROOM_LIMITS,
  usage: {
    turns: 0,
    rounds: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimated: false,
    costUsd: null,
    activeMs: 0,
    consecutiveRepetitive: 0,
  },
  round: 0,
  spokenThisRound: [],
  nextSpeakerId: null,
  stopReason: null,
  rev: 0,
  createdAt: 1,
  updatedAt: 1,
}

const turnStart: RoomJournalRecord = {
  type: 'turn-start',
  turnId: 't1',
  speaker: { kind: 'system' },
  round: 1,
  at: 2,
}

describe('rooms service', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it('invokes each command with camelCase args', async () => {
    mockInvoke.mockResolvedValueOnce([])
    await expect(listRooms()).resolves.toEqual([])
    expect(mockInvoke).toHaveBeenLastCalledWith('rooms_list', {})

    mockInvoke.mockResolvedValueOnce({ room, journal: [] })
    await expect(getRoom('r1')).resolves.toEqual({ room, journal: [] })
    expect(mockInvoke).toHaveBeenLastCalledWith('room_get', { roomId: 'r1' })

    const saved = { ...room, rev: 1, updatedAt: 99 }
    mockInvoke.mockResolvedValueOnce(saved)
    await expect(saveRoom(room)).resolves.toEqual(saved)
    expect(mockInvoke).toHaveBeenLastCalledWith('room_save', { room })

    mockInvoke.mockResolvedValueOnce(turnStart)
    await expect(appendRoomRecord('r1', turnStart)).resolves.toEqual(turnStart)
    expect(mockInvoke).toHaveBeenLastCalledWith('room_append', {
      roomId: 'r1',
      record: turnStart,
    })

    mockInvoke.mockResolvedValueOnce(null)
    await expect(deleteRoom('r1')).resolves.toBeUndefined()
    expect(mockInvoke).toHaveBeenLastCalledWith('room_delete', { roomId: 'r1' })
  })

  it('rejects with a normalised RoomError', async () => {
    mockInvoke.mockRejectedValueOnce({
      code: 'stale_revision',
      message: 'rev moved',
    })
    await expect(saveRoom(room)).rejects.toEqual({
      code: 'stale_revision',
      message: 'rev moved',
    })

    mockInvoke.mockRejectedValueOnce(
      'invalid args `room` for command `room_save`: missing field `v`'
    )
    await expect(saveRoom(room)).rejects.toEqual({
      code: 'unknown',
      message: 'invalid args `room` for command `room_save`: missing field `v`',
    })

    mockInvoke.mockRejectedValueOnce(new Error('not_found: room r1 not found'))
    await expect(getRoom('r1')).rejects.toEqual({
      code: 'not_found',
      message: 'room r1 not found',
    })
  })
})

describe('toRoomError', () => {
  it('accepts { code, message } objects', () => {
    expect(toRoomError({ code: 'too_large', message: 'big' })).toEqual({
      code: 'too_large',
      message: 'big',
    })
    expect(toRoomError({ code: 'io' })).toEqual({ code: 'io', message: 'io' })
  })

  it('reads a code at the start of an Error message or string', () => {
    expect(toRoomError(new Error('invalid_id: bad'))).toEqual({
      code: 'invalid_id',
      message: 'bad',
    })
    expect(toRoomError('invalid_room missing field')).toEqual({
      code: 'invalid_room',
      message: 'missing field',
    })
    expect(toRoomError('not_found')).toEqual({
      code: 'not_found',
      message: 'not_found',
    })
  })

  it('falls back to unknown', () => {
    expect(toRoomError({ code: 'nope', message: 'x' })).toEqual({
      code: 'unknown',
      message: 'x',
    })
    expect(toRoomError(new Error('boom'))).toEqual({
      code: 'unknown',
      message: 'boom',
    })
    expect(toRoomError('something_else: y')).toEqual({
      code: 'unknown',
      message: 'something_else: y',
    })
    expect(toRoomError(42)).toEqual({ code: 'unknown', message: '42' })
    expect(toRoomError(null)).toEqual({ code: 'unknown', message: 'null' })
    expect(toRoomError(undefined)).toEqual({
      code: 'unknown',
      message: 'unknown error',
    })
  })

  it('knows exactly the contract codes', () => {
    for (const code of [
      'not_found',
      'invalid_id',
      'invalid_room',
      'stale_revision',
      'too_large',
      'io',
      'unknown',
    ]) {
      expect(isRoomErrorCode(code)).toBe(true)
    }
    expect(isRoomErrorCode('toString')).toBe(false)
    expect(isRoomErrorCode('Not_Found')).toBe(false)
  })
})
