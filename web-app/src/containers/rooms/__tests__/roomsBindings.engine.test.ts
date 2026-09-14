import { afterEach, describe, expect, it } from 'vitest'
import { loadEngineApi } from '../roomsBindings'
import { setRoomPersistence } from '@/lib/rooms/persistence'
import { memoryPersistence } from '@/lib/rooms/__tests__/helpers'

// The UI seam adapts the engine by export and state names. This checks those
// names against the real engine modules instead of a fake, so a rename on
// either side fails here rather than rendering "unavailable" at runtime.
describe('rooms UI seam against the real engine', () => {
  afterEach(() => setRoomPersistence(null))

  it('adapts the real store and controller and round-trips a room', async () => {
    setRoomPersistence(memoryPersistence())
    const api = await loadEngineApi()
    expect(api.status).toBe('ready')
    for (const method of [
      'start',
      'pause',
      'resume',
      'stop',
      'selectNext',
      'sendUserMessage',
      'callVote',
      'requestFinalPositions',
      'synthesize',
      'cancelTurn',
    ] as const) {
      expect(typeof api.controller[method]).toBe('function')
    }

    const room = await api.createRoom({ title: 'Seam check', objective: 'Wire it' })
    expect(room.id).toBeTruthy()
    expect(room.status).toBe('draft')

    await api.loadSummaries()
    expect(api.getState().summaries.map((s) => s.id)).toContain(room.id)

    await api.loadRoom(room.id)
    expect(api.getState().room?.id).toBe(room.id)

    const renamed = await api.updateRoomSettings(api.getState().room!, {
      title: 'Seam check 2',
    })
    expect(renamed.title).toBe('Seam check 2')

    await api.deleteRoom(room.id)
    await api.loadSummaries()
    expect(api.getState().summaries.map((s) => s.id)).not.toContain(room.id)
  })
})
