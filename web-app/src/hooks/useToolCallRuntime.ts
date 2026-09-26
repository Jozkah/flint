import { create } from 'zustand'

export type ToolCallTiming = {
  /** Unset until the executor reaches this call. */
  startedAt?: number
  endedAt?: number
}

/** A `notifications/progress` update from an MCP server. */
export type ToolProgressUpdate = {
  server: string
  progress: number
  total?: number
  message?: string
  /** Only set when the server reported a usable total. */
  percent?: number
}

/** The readable half of the store, for selectors defined outside it. */
export type ToolCallRuntimeSnapshot = {
  /**
   * Calls the executor has not reached yet, in execution order. Position is
   * read from here rather than stored per call, so entries move up as the ones
   * ahead of them start.
   */
  queue: string[]
  timings: Record<string, ToolCallTiming>
  /** Latest progress update per call, cleared when the call settles. */
  progress: Record<string, ToolProgressUpdate>
  /**
   * Unified diff per `write`/`edit` call. Display-only: it deliberately never
   * enters the model-facing tool output, so it cannot travel on the message part
   * and needs a side channel. Unlike `progress` it is kept after the call
   * settles, since the diff is the whole point of the finished card.
   */
  diffs: Record<string, string>
  /**
   * Live `bash` output per call, as streamed by the backend: raw, so it keeps
   * the command's ANSI colours (the model-facing result has them stripped).
   * Kept after the call settles so the finished card can still show colours.
   */
  output: Record<string, string>
  /**
   * The sandboxed run of a `bash` call the user then allowed to run again
   * outside the sandbox. The card shows the rerun as the result and keeps
   * this collapsed as the "first attempt". Display-only, like `diffs`.
   */
  firstAttempts: Record<string, { output: string; isError: boolean }>
  /**
   * The conversation each enqueued call belongs to. The store is shared by
   * every mounted conversation (a split view runs two at once), so a turn's
   * housekeeping must only touch its own calls.
   */
  owners: Record<string, string>
}

type ToolCallRuntimeState = ToolCallRuntimeSnapshot & {
  /**
   * Starts a turn. Earlier timings are kept: their cards are still on screen
   * and would otherwise lose the duration they had been showing.
   */
  enqueue: (toolCallIds: string[], owner?: string) => void
  markRunning: (toolCallId: string) => void
  markSettled: (toolCallId: string) => void
  /**
   * Records an MCP progress update against the running call. The notification
   * carries no tool call id or conversation, so it is attached only when
   * exactly one call is running; with two conversations running tools at once
   * it cannot be attributed and is dropped rather than shown on the wrong card.
   */
  reportProgress: (update: ToolProgressUpdate) => void
  /** Records a display-only diff against the call that produced it. */
  recordDiff: (toolCallId: string, diff: string) => void
  /** Appends a chunk of live command output to the call that produced it. */
  appendOutput: (toolCallId: string, text: string) => void
  /**
   * Keeps a call's sandboxed run as its first attempt after an unsandboxed
   * rerun. Its streamed output belonged to that run, so it is dropped: the
   * rerun's result is what the card shows now.
   */
  recordFirstAttempt: (
    toolCallId: string,
    attempt: { output: string; isError: boolean }
  ) => void
  /** Ends a turn: nothing still queued will run, so stop showing it as waiting. */
  settleRemaining: (owner?: string) => void
  reset: () => void
  /**
   * Drops these calls' entries and nothing else. `reset` clears every
   * conversation's, which is right when only one is on screen and wrong when
   * a split pane is still showing the other's timings and diffs.
   */
  forget: (toolCallIds: string[]) => void
}

/**
 * The call currently executing, if any. Returns a primitive, so it is safe to
 * use directly as a store selector.
 */
export function findRunningToolCallId(
  timings: Record<string, ToolCallTiming>
): string | undefined {
  for (const [id, timing] of Object.entries(timings)) {
    if (timing.startedAt !== undefined && timing.endedAt === undefined) {
      return id
    }
  }
  return undefined
}

/**
 * Timing and queue position for in-flight tool calls -- the two things the SDK
 * message part cannot express, since a queued call and a running one are both
 * `input-available`. Status itself stays derived from the part, so it is not
 * duplicated here.
 */
export const useToolCallRuntime = create<ToolCallRuntimeState>()((set) => ({
  queue: [],
  timings: {},
  progress: {},
  diffs: {},
  output: {},
  firstAttempts: {},
  owners: {},

  enqueue: (toolCallIds, owner) =>
    set((s) => {
      const timings = { ...s.timings }
      const ownerOf = (id: string) => s.owners[id]
      // A turn cannot start while a call from the previous one *in the same
      // conversation* is still running, so anything of this conversation left
      // running was stranded by a severed turn (HMR in dev, a reload, a crashed
      // executor). Another pane's running call is live and is left alone.
      for (const [id, timing] of Object.entries(timings)) {
        if (
          timing.startedAt !== undefined &&
          timing.endedAt === undefined &&
          ownerOf(id) === owner
        ) {
          timings[id] = { ...timing, endedAt: Date.now() }
        }
      }
      const owners = { ...s.owners }
      for (const id of toolCallIds) {
        if (owner === undefined) delete owners[id]
        else owners[id] = owner
      }
      return {
        // Only this conversation's queue is replaced.
        queue: [
          ...s.queue.filter((id) => ownerOf(id) !== owner),
          ...toolCallIds,
        ],
        timings: {
          ...timings,
          ...Object.fromEntries(toolCallIds.map((id) => [id, {}])),
        },
        owners,
      }
    }),

  markRunning: (toolCallId) =>
    set((s) =>
      s.timings[toolCallId]
        ? {
            queue: s.queue.filter((id) => id !== toolCallId),
            timings: {
              ...s.timings,
              [toolCallId]: { ...s.timings[toolCallId], startedAt: Date.now() },
            },
          }
        : s
    ),

  markSettled: (toolCallId) =>
    set((s) => {
      if (!s.timings[toolCallId]) return s
      const progress = { ...s.progress }
      delete progress[toolCallId]
      return {
        queue: s.queue.filter((id) => id !== toolCallId),
        timings: {
          ...s.timings,
          [toolCallId]: { ...s.timings[toolCallId], endedAt: Date.now() },
        },
        progress,
      }
    }),

  reportProgress: (update) =>
    set((s) => {
      const running = Object.entries(s.timings).filter(
        ([, t]) => t.startedAt !== undefined && t.endedAt === undefined
      )
      if (running.length !== 1) return s
      const [id] = running[0]
      return { progress: { ...s.progress, [id]: update } }
    }),

  recordDiff: (toolCallId, diff) =>
    set((s) => ({ diffs: { ...s.diffs, [toolCallId]: diff } })),

  appendOutput: (toolCallId, text) =>
    set((s) => ({
      output: {
        ...s.output,
        [toolCallId]: (s.output[toolCallId] ?? '') + text,
      },
    })),

  recordFirstAttempt: (toolCallId, attempt) =>
    set((s) => {
      const output = { ...s.output }
      delete output[toolCallId]
      return {
        firstAttempts: { ...s.firstAttempts, [toolCallId]: attempt },
        output,
      }
    }),

  settleRemaining: (owner) =>
    set((s) => {
      const mine = s.queue.filter((id) => s.owners[id] === owner)
      if (mine.length === 0) return s
      const now = Date.now()
      const timings = { ...s.timings }
      for (const id of mine) {
        timings[id] = { ...timings[id], endedAt: now }
      }
      return { queue: s.queue.filter((id) => s.owners[id] !== owner), timings }
    }),

  reset: () =>
    set({
      queue: [],
      timings: {},
      progress: {},
      diffs: {},
      output: {},
      firstAttempts: {},
      owners: {},
    }),

  forget: (toolCallIds) =>
    set((s) => {
      if (toolCallIds.length === 0) return s
      const drop = new Set(toolCallIds)
      const keep = <T>(record: Record<string, T>) =>
        Object.fromEntries(
          Object.entries(record).filter(([id]) => !drop.has(id))
        ) as Record<string, T>
      return {
        queue: s.queue.filter((id) => !drop.has(id)),
        timings: keep(s.timings),
        progress: keep(s.progress),
        diffs: keep(s.diffs),
        output: keep(s.output),
        firstAttempts: keep(s.firstAttempts),
        owners: keep(s.owners),
      }
    }),
}))

/**
 * Run one tool call with its timing recorded, so its card can show a live
 * duration instead of a bare spinner.
 *
 * For a caller that dispatches serially and so has no queue to report -- each
 * call is its own queue of one. The chat route enqueues a whole step up front
 * instead, which is what lets it also show "queued, 2nd in line".
 */
export async function withToolTiming<T>(
  toolCallId: string,
  run: () => Promise<T>
): Promise<T> {
  const runtime = useToolCallRuntime.getState()
  runtime.enqueue([toolCallId])
  runtime.markRunning(toolCallId)
  try {
    return await run()
  } finally {
    useToolCallRuntime.getState().markSettled(toolCallId)
  }
}
