import { create } from 'zustand'
import { loadRunEndings, saveRunEndings } from '@/lib/runEndingsStorage'
import type { CoworkRunState } from '@/hooks/coworkRun/types'
import { runLifecycleSlice } from '@/hooks/coworkRun/lifecycleSlice'
import { runStreamSlice } from '@/hooks/coworkRun/streamSlice'
import { subagentActions } from '@/hooks/coworkRun/subagentSlice'
import { runRequestsSlice } from '@/hooks/coworkRun/requestsSlice'
import { askActions } from '@/hooks/coworkRun/askSlice'

export type { RunEnding, StreamEvent, CoworkRunState } from '@/hooks/coworkRun/types'
// The ask shapes live in the store-free types module; re-exported here because
// this store is where the pending-ask queue lives.
export type {
  AskOption,
  AskQuestion,
  AskRequestPayload,
  AskAnswer,
  AskRecord,
} from '@/types/coworkSession'
export {
  makeToolCallTurn,
  toolOutcome,
  attachAskToTurns,
  settleAskInTurns,
  attachPromptSnapshotToTurns,
  interruptRunningTools,
  applyInnerToTurns,
} from '@/hooks/coworkRun/turns'
export { loadRunEndings }

export const useCoworkRun = create<CoworkRunState>()((set, get) => ({
  liveTurns: {},
  subagents: {},
  pendingAsks: {},
  promptSnapshots: {},
  usage: {},
  runs: {},
  outcomes: loadRunEndings(),

  pendingPreview: null,
  pendingCodeOpen: null,
  attachFolderRequested: false,
  llamacppRuns: {},
  pendingLlamacppError: {},
  loadingModels: {},
  modelLoadProgress: {},

  ...runLifecycleSlice(set, get),
  ...runStreamSlice(set),
  ...subagentActions(set),
  ...runRequestsSlice(set, get),
  ...askActions(set),
}))

// Saved whenever a run ending changes (set, cleared by a new run, forgotten).
useCoworkRun.subscribe((state, previous) => {
  if (state.outcomes !== previous.outcomes) saveRunEndings(state.outcomes)
})
