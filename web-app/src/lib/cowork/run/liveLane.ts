import { checkpoint as inFlightCheckpoint, checkpointDue } from '@/lib/coworkInflight'
import { createFrameBatch } from '@/lib/frameBatch'
import { recordMemoryUses } from '@/lib/memoryUses'
import type { PromptSnapshotRef } from '@/lib/providerFetch'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import type { CoworkTurn } from '@/types/coworkSession'
import type { RunState } from './runState'

/** What a run's live lane reads, named rather than closed over. */
export type LiveLaneContext = {
  rs: RunState
  sid: string
  runId: string
  runStartedAt: number
  runBaseCount: number
  /** This session's latest prompt snapshot, read when a row is pushed. */
  latestSnapshot: () => PromptSnapshotRef | undefined
  /** The run's project folder, for memory-use records. */
  projectRoot: () => string | undefined
}

/**
 * This run's live lane: the writes that publish `rs.runTurns` to the run store
 * and checkpoint them with the session. Every write names the run, so once
 * the run is stopped, replaced or its session deleted, a late write is
 * refused rather than drawn under whatever session is in view.
 */
export function createLiveLane(ctx: LiveLaneContext) {
  const { rs, sid, runId } = ctx
  // AH-026: the live lane is also kept with the session while the run goes,
  // so a run the app is killed under comes back as an interrupted turn.
  const saveInFlight = (step = false) => {
    const at = Date.now()
    if (!checkpointDue(rs.lastCheckpointAt, at, step)) return
    rs.lastCheckpointAt = at
    // Only while this run still owns the session's live lane.
    if (useCoworkRun.getState().runs[sid]?.runId !== runId) return
    useCoworkSessions
      .getState()
      .setInFlight(sid, inFlightCheckpoint(runId, ctx.runStartedAt, ctx.runBaseCount, rs.runTurns, at))
  }
  // Text deltas publish at most once per frame: a set per token woke every
  // `useCoworkRun` subscriber and re-rendered the route per token, which is
  // what made scrolling a streaming transcript lag. Any other write publishes
  // at once and takes the queued text with it, so ordering is unchanged.
  const textFrame = createFrameBatch(() => publish())
  const publish = () => {
    textFrame.cancel()
    useCoworkRun.getState().setRunTurns(sid, runId, [...rs.runTurns])
    saveInFlight()
  }
  const pushLive = (
    turns: CoworkTurn[],
    snapshot: PromptSnapshotRef | undefined = ctx.latestSnapshot()
  ) => {
    // AH-078. Bind each assistant row to the dispatch that produced it,
    // here, because here is where the row first exists: at dispatch the
    // lane holds the user turn and nothing else, so a reference written
    // then has nothing to land on. The snapshot is this session's latest,
    // so a continuation, a retry and a compaction each carry their own --
    // unless the caller names the step's own (see `stepSnapshot`).
    const stamped = turns.map((turn) =>
      turn.role === 'assistant' && !turn.promptSnapshot && snapshot
        ? { ...turn, promptSnapshot: snapshot }
        : turn
    )
    rs.runTurns = [...rs.runTurns, ...stamped]
    publish()
    // AH-083: the memories this row's request carried now know the turn and
    // the exact snapshot they went out in. Here for the same reason as the
    // stamp above: this is where the row, its memory and its snapshot meet.
    // Named by this run's session, never the one in view.
    for (const turn of stamped) {
      if (turn.role !== 'assistant' || !turn.memory?.injectedIds.length) continue
      void recordMemoryUses({
        sessionId: sid,
        projectRoot: ctx.projectRoot(),
        memory: turn.memory,
        turnId: turn.promptSnapshot?.id
          ? `turn-${turn.promptSnapshot.id}`
          : undefined,
        snapshotId: turn.promptSnapshot?.id,
      })
    }
  }
  const mutateLive = (apply: (turns: CoworkTurn[]) => CoworkTurn[]) => {
    const next = apply(rs.runTurns)
    if (next === rs.runTurns) return
    rs.runTurns = next
    publish()
  }
  return { saveInFlight, textFrame, publish, pushLive, mutateLive }
}
