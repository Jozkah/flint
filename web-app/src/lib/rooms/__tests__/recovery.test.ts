import { describe, it, expect, vi } from 'vitest'
import {
  messagesFromJournal,
  recoverRoomsOnLoad,
  scheduleRoomRecovery,
  unmatchedTurnStarts,
} from '../recovery'
import { runRoom } from '../engine'
import { engineDeps, makeRoom, memoryPersistence, messagesOf, scriptedStream, seedRoom } from './helpers'
import { emptyUsage } from '../limits'
import type { RoomJournalRecord } from '../types'

const speaker = { kind: 'participant' as const, participantId: 'p-a', name: 'Alice' }

function journalWithOrphan(): RoomJournalRecord[] {
  return [
    { type: 'turn-start', turnId: 't1', speaker, round: 1, at: 10 },
    {
      type: 'message',
      message: {
        v: 1, id: 'm1', roomId: 'room-1', seq: 1, turnId: 't1', author: speaker, to: { kind: 'room' },
        kind: 'speech', text: 'done', round: 1, createdAt: 11, status: 'complete',
      },
    },
    { type: 'turn-start', turnId: 't2', speaker, round: 1, at: 12 },
  ]
}

describe('restart recovery', () => {
  it('reconstructs a turn-start without a message as an interrupted empty message', () => {
    const journal = journalWithOrphan()
    expect(unmatchedTurnStarts(journal).map((r) => r.turnId)).toEqual(['t2'])
    const messages = messagesFromJournal('room-1', journal)
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({ turnId: 't2', text: '', status: 'interrupted', kind: 'speech', author: speaker })
    expect(messages[1].seq).toBeGreaterThan(messages[0].seq)
  })

  it('pauses running and awaiting-user rooms with interrupted-by-restart, idempotently', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ id: 'r-run', status: 'running', updatedAt: 5 }))
    p.journals.set('r-run', journalWithOrphan().map((r) => (r.type === 'message' ? { ...r, message: { ...r.message, roomId: 'r-run' } } : r)))
    await seedRoom(p, makeRoom({ id: 'r-wait', status: 'awaiting-user', updatedAt: 4 }))
    await seedRoom(p, makeRoom({ id: 'r-paused', status: 'paused', updatedAt: 3 }))
    await seedRoom(p, makeRoom({ id: 'r-done', status: 'completed', updatedAt: 2 }))

    const recovered = await recoverRoomsOnLoad(p, () => 99)
    expect(recovered.sort()).toEqual(['r-run', 'r-wait'])
    expect(p.rooms.get('r-run')).toMatchObject({ status: 'paused', stopReason: { kind: 'interrupted-by-restart' } })
    expect(p.rooms.get('r-wait')).toMatchObject({ status: 'paused', stopReason: { kind: 'interrupted-by-restart' } })
    expect(p.rooms.get('r-paused')!.rev).toBe(0)
    expect(p.rooms.get('r-done')!.status).toBe('completed')

    const runMessages = messagesOf(p, 'r-run')
    expect(runMessages.find((m) => m.turnId === 't2')).toMatchObject({ status: 'interrupted', text: '', seq: 2 })
    expect(runMessages[runMessages.length - 1]).toMatchObject({ kind: 'system' })
    expect(unmatchedTurnStarts(p.journals.get('r-run')!)).toEqual([])

    expect(await recoverRoomsOnLoad(p, () => 100)).toEqual([])
  })

  it('logs per-room failures instead of throwing', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ id: 'bad', status: 'running' }))
    p.getRoom = async () => {
      throw { code: 'io', message: 'disk' }
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(recoverRoomsOnLoad(p)).resolves.toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('scheduleRoomRecovery runs only when enabled and never rejects', async () => {
    const run = vi.fn(async () => {
      throw new Error('boom')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await scheduleRoomRecovery(false, run)
    expect(run).not.toHaveBeenCalled()
    await expect(scheduleRoomRecovery(true, run)).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('the engine persists the interrupted message for an orphaned turn on load', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ status: 'paused', usage: { ...emptyUsage(), turns: 1 }, limits: { maxTurns: 1 } }))
    p.journals.set('room-1', journalWithOrphan())
    const { fn, calls } = scriptedStream(() => ({ text: 'x' }))
    const room = await runRoom('room-1', engineDeps(p, fn), new AbortController().signal)
    expect(calls).toHaveLength(0)
    expect(room.stopReason).toEqual({ kind: 'limit', limit: 'maxTurns' })
    expect(unmatchedTurnStarts(p.journals.get('room-1')!)).toEqual([])
  })
})
