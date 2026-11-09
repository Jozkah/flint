// `RemoteActions` for stopping: one run, a whole conversation, or everything.

import { invokeCommand } from '@/lib/backend'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useAppState } from '@/hooks/useAppState'
import { useMessageQueue } from '@/stores/message-queue-store'
import { holdQueueThenStop } from '@/lib/chatSteering'
import { abortAll, abortRun } from '@/lib/coworkRunner'
import { roomController } from '@/lib/rooms/controller'
import { useRoomsStore } from '@/lib/rooms/store'
import { RemoteRpcError } from './bridge'
import type { RemoteActions } from './actions'
import type { AppActionContext } from './appActionsShared'

/** Emergency stop in the backend (CoworkStopMenu's `agent_emergency_stop`). */
async function backendStop(args: { session?: string; run?: string }): Promise<{ stopped?: number } | null> {
  if (!IS_TAURI) return null
  return invokeCommand<{ stopped?: number }>('agent_emergency_stop', args).catch((e) => {
    console.warn('remote: emergency stop failed', e)
    return null
  })
}

export function stopActions(ctx: AppActionContext): Pick<
  RemoteActions,
  | 'stop'
  | 'stopConversation'
  | 'stopAll'
> {
  const { ensureChatComposer } = ctx
  return {
    stop: async (kind, id) => {
      if (kind === 'room') {
        if (!useRoomsStore.getState().runningRoomIds.includes(id)) return false
        await roomController.stop(id)
        return true
      }
      if (kind === 'chat') {
        if (!useAppState.getState().busyThreads[id]) return false
        const entry = await ensureChatComposer(id)
        if (!entry?.stop) {
          throw new RemoteRpcError('unavailable', 'Could not reach the chat to stop it')
        }
        entry.stop()
        return true
      }
      const run = useCoworkRun.getState().runs[id]
      if (!run) return false
      // CoworkStopMenu's "Stop current task": hold the queue, abort the loop,
      // then the scoped backend stop for the tools under it.
      holdQueueThenStop([id], () => abortRun(id))
      await backendStop({ session: id, run: run.runId })
      return true
    },

    // CoworkStopMenu's "Stop all in this chat": the local abort, then the
    // backend stop scoped to the whole session rather than one run.
    stopConversation: async (kind, id) => {
      if (kind === 'room') {
        if (!useRoomsStore.getState().runningRoomIds.includes(id)) return 0
        await roomController.stop(id)
        return 1
      }
      if (kind === 'chat') {
        const composer = await ensureChatComposer(id)
        composer?.stop?.()
      } else if (useCoworkRun.getState().runs[id]) {
        holdQueueThenStop([id], () => abortRun(id))
      }
      const result = await backendStop({ session: id })
      return typeof result?.stopped === 'number' ? result.stopped : 0
    },

    stopAll: async () => {
      let count = 0
      holdQueueThenStop(Object.keys(useMessageQueue.getState().queues), () => {
        count = abortAll()
      })
      await backendStop({})
      return count
    },
  }
}
