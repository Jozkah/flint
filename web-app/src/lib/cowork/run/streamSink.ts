import { recordShellDispatch, type RunContext } from '@/lib/coworkActivityRecorder'
import type { StreamSink } from '@/lib/coworkRunner'
import { commandOf } from '@/lib/coworkTasks'
import { recordEvents } from '@/lib/eventLog'
import type { createDecodeClock } from '@/lib/tokenSpeed'
import { SHOW_WIDGET_TOOL } from '@/lib/visualize/constants'
import type { CoworkTurn } from '@/types/coworkSession'
import type { RunState } from './runState'

/** What a run's stream sink reads and writes, named rather than closed over. */
export type StreamSinkContext = {
  rs: RunState
  run: RunContext
  decodeClock: ReturnType<typeof createDecodeClock>
  /** Publishes the lane at the next frame (text deltas). */
  scheduleFrame: () => void
  publish: () => void
  pushLive: (turns: CoworkTurn[]) => void
  saveInFlight: (step?: boolean) => void
  anchorMessageId: () => string | undefined
}

/**
 * The sink a run's model steps stream into, and the set of assistant rows the
 * current step streamed.
 *
 * Only rows streamed by the current model step may receive new deltas. A
 * previous step can end with an assistant row, and the next model reply must
 * not append to it before the settled row replaces the live one.
 */
export function createStreamSink(ctx: StreamSinkContext) {
  const { rs, run } = ctx
  const streamed = new Set<CoworkTurn>()
  const clearStreamedTurns = () => {
    if (streamed.size === 0) return
    rs.runTurns = rs.runTurns.filter((turn) => !streamed.has(turn))
    streamed.clear()
    ctx.publish()
  }
  const sink: StreamSink = {
    onOutput: (chars) => ctx.decodeClock.tick(chars),
    onText: (delta) => {
      const last = rs.runTurns[rs.runTurns.length - 1]
      if (last && last.role === 'assistant' && streamed.has(last)) {
        last.content += delta
        ctx.scheduleFrame()
      } else {
        ctx.pushLive([{ role: 'assistant', content: delta }])
        const added = rs.runTurns[rs.runTurns.length - 1]
        if (added?.role === 'assistant') streamed.add(added)
      }
    },
    onToolStart: (callId, name) =>
      ctx.pushLive([
        { role: 'tool', content: '', callId, name, status: 'running' },
      ]),
    // Only a widget's arguments are kept as they stream: it is the one call
    // whose card draws from them before the call is complete.
    onToolArgsDelta: (callId, delta) => {
      const row = rs.runTurns.find((turn) => turn.callId === callId)
      if (row?.name !== SHOW_WIDGET_TOOL) return
      row.argsLive = (row.argsLive ?? '') + delta
      ctx.scheduleFrame()
    },
    onToolCall: (call) => {
      const row = rs.runTurns.find((turn) => turn.callId === call.toolCallId)
      if (row) {
        row.args = call.input
        row.argsLive = undefined
        ctx.publish()
        // #321: checkpointed now, not at the next step or text delta. A
        // crash between here and the step's end otherwise left the saved
        // call without its arguments, and resuming replayed it without them.
        ctx.saveInFlight(true)
      }
      // A shell command is background work the moment it starts, and its
      // arguments are the only place the command line exists.
      const command = commandOf(call.input)
      if (command) {
        recordShellDispatch(run, {
          callId: call.toolCallId,
          command,
          anchorMessageId: ctx.anchorMessageId(),
        })
        recordEvents([
          {
            id: `job:${call.toolCallId}:started`,
            session: run.sessionId,
            run: run.runId,
            kind: 'job.started',
            payload: { tool: 'bash', command },
          },
        ])
      }
    },
  }
  return { sink, streamed, clearStreamedTurns }
}
