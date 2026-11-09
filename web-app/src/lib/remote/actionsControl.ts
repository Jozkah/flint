// The run-control handlers a phone calls: stopping runs and steering rooms.

import { RemoteRpcError, type RemoteHandlers } from './bridge'
import type { RoomControlParams, SessionKind } from './protocol'
import type { ActionContext } from './actionTypes'
import { isRecord, str } from './actionParams'

/** Run control: stopping runs and steering rooms. */
export function controlHandlers(ctx: ActionContext): Pick<RemoteHandlers, 'run.stop' | 'room.control'> {
  const { a } = ctx
  return {
    'run.stop': async (params) => {
      const p = (isRecord(params) ? params : {}) as Record<string, unknown>
      if (p.all === true) return { stopped: await a.stopAll() }
      const kind = p.kind as SessionKind
      const id = str(p.id)
      if (!id || !['chat', 'cowork', 'room'].includes(kind)) {
        throw new RemoteRpcError('bad_params', 'kind and id are required')
      }
      if (p.scope === 'chat') {
        if (!a.stopConversation) throw new RemoteRpcError('not_implemented', 'Stopping a whole chat is not available from phones yet')
        return { stopped: await a.stopConversation(kind, id) }
      }
      return { stopped: (await a.stop(kind, id)) ? 1 : 0 }
    },
    'room.control': async (params) => {
      const p = (isRecord(params) ? params : {}) as Partial<RoomControlParams>
      const id = str(p.id)
      if (!id) throw new RemoteRpcError('bad_params', 'id is required')
      if (!(await a.roomExists(id))) throw new RemoteRpcError('not_found', 'No such room')
      a.open('room', id)
      switch (p.action) {
        case 'start':
          await a.room.start(id)
          break
        case 'pause':
          await a.room.pause(id)
          break
        case 'resume':
          await a.room.resume(id)
          break
        case 'stop':
          await a.room.stop(id)
          break
        case 'cancel':
          await a.room.cancelTurn(id)
          break
        case 'next': {
          const who = str(p.participantId)
          if (!who) throw new RemoteRpcError('bad_params', 'participantId is required')
          await a.room.selectNext(id, who)
          break
        }
        case 'vote': {
          const proposal = typeof p.proposal === 'string' ? p.proposal.trim() : ''
          if (!proposal) throw new RemoteRpcError('bad_params', 'The proposal is empty')
          await a.room.callVote(id, proposal)
          break
        }
        case 'synthesize':
          await a.room.synthesize(id)
          break
        case 'final':
          await a.room.requestFinalPositions(id)
          break
        default:
          throw new RemoteRpcError('bad_params', 'Unknown room action')
      }
      return { ok: true }
    },
  }
}
