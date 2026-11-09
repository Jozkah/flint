// `RemoteActions` for rooms.

import { roomController } from '@/lib/rooms/controller'
import { getRoomPersistence } from '@/lib/rooms/persistence'
import { useRoomsStore } from '@/lib/rooms/store'
import type { RemoteActions } from './actions'

export function roomActions(): Pick<RemoteActions, 'roomExists' | 'room'> {
  return {
    roomExists: async (id) => {
      if (useRoomsStore.getState().summaries.some((r) => r.id === id)) return true
      try {
        await getRoomPersistence().getRoom(id)
        return true
      } catch {
        return false
      }
    },

    room: {
      send: (id, text, to) => roomController.sendUserMessage(id, text, to),
      start: (id) => roomController.start(id),
      pause: (id) => roomController.pause(id),
      resume: (id) => roomController.resume(id),
      stop: (id) => roomController.stop(id),
      cancelTurn: (id) => roomController.cancelTurn(id),
      selectNext: (id, who) => roomController.selectNext(id, who),
      callVote: (id, proposal) => roomController.callVote(id, proposal),
      synthesize: (id) => roomController.synthesize(id),
      requestFinalPositions: (id) => roomController.requestFinalPositions(id),
    },
  }
}
