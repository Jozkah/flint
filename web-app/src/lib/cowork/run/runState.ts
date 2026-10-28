import type { GitBaseline } from '@/lib/coworkOrigins'
import type { RunOutcome } from '@/lib/coworkRunner'
import type { PromptSnapshotRef } from '@/lib/providerFetch'
import type { CoworkTurn } from '@/types/coworkSession'

/**
 * The mutable state of one Cowork run, in one place.
 *
 * `runRequest` used to keep these as `let` bindings that its nested callbacks
 * wrote to; the phases moved into lib/cowork/run read and write them here
 * instead, so a phase can live outside the route and still see the run's
 * current values.
 */
export type RunState = {
  /** This run's live lane. */
  runTurns: CoworkTurn[]
  lastCheckpointAt: number | undefined
  runBaseline: GitBaseline | null
  runTooling: string | null
  stepSnapshot: PromptSnapshotRef | undefined
  /** A window learned from a server refusal, for the rest of this run. */
  learnedWindow: number | null
  /** A request queued to run once this one finishes cleanly. */
  continueWith: string | null
  /** The folder offer is made once per run. */
  folderOffered: boolean
  outcome: RunOutcome | null
  thrown: Pick<RunOutcome, 'stoppedBy' | 'errorText'> | null
}

export function createRunState(runTurns: CoworkTurn[]): RunState {
  return {
    runTurns,
    lastCheckpointAt: undefined,
    runBaseline: null,
    runTooling: null,
    stepSnapshot: undefined,
    learnedWindow: null,
    continueWith: null,
    folderOffered: false,
    outcome: null,
    thrown: null,
  }
}
