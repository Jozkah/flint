import type { BudgetStop } from '@/lib/coworkBudget'
import { messageWeight, transcriptWindowStart } from '@/lib/transcriptWindow'
import {
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { CoworkTurn, Usage } from '@/types/coworkSession'
import { appendLiveMessages, coworkTurnsToUIMessages } from '@/lib/coworkTurns'
import { reconcileToolActivity } from '@/lib/coworkActivityTimeline'
import { loadToolActivity, type ToolActivityItem } from '@/lib/toolActivity'
import { useCoworkCheckpoints } from '@/hooks/useCoworkCheckpoints'
import { useCoworkDisplay } from '@/hooks/useCoworkDisplay'
import { fromCoworkUsage, summarizeUsage } from '@/lib/tokenUsage'
import { speedStats } from '@/lib/tokenSpeed'
import { isFlintInternalPath } from '@/lib/coworkSandboxApply'
import {
  NO_USER_EDITS,
  useCoworkUserEdits,
} from '@/hooks/useCoworkUserEdits'
import { collectCodeFileDiffs } from '@/lib/coworkDiffs'
import {
  deriveRunOutcome,
  } from '@/lib/coworkRunOutcome'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { SessionOrigins } from '@/hooks/useCoworkOrigins'

export type CoworkTranscriptArgs = {
  session: CoworkSession | null
  running: boolean
  liveTurns: CoworkTurn[]
  stoppedBy: 'done' | BudgetStop | 'error' | 'aborted' | 'deadline' | 'timeout' | 'loop'
  runError: string | undefined
  runOrigins: SessionOrigins | null
  liveUsage: Usage | null
  workspacePath: string | null
}

export function useCoworkTranscript({
  session,
  running,
  liveTurns,
  stoppedBy,
  runError,
  runOrigins,
  liveUsage,
  workspacePath,
}: CoworkTranscriptArgs) {

  // `liveTurns` holds only the rows this run has produced — `commitTurns`
  // appends them — so the committed transcript has to be shown alongside it or
  // the conversation disappears the moment a follow-up run starts.
  /**
   * The canonical record of this session's tool calls. AH-050/AH-172.
   *
   * Reloaded when the session changes and when a run ends: during a run the
   * live turns already carry the same states, and re-reading the log on every
   * event would be a file read per tool call for no gain.
   */
  const [toolActivity, setToolActivity] = useState<ToolActivityItem[]>([])
  useEffect(() => {
    if (!session?.id) {
      setToolActivity([])
      return
    }
    let current = true
    loadToolActivity(session.id).then((items) => {
      if (current) setToolActivity(items)
    })
    return () => {
      current = false
    }
  }, [session?.id, running])

  const displayedTurns = useMemo(
    () =>
      reconcileToolActivity(
        running
          ? [...(session?.turns ?? []), ...liveTurns]
          : (session?.turns ?? []),
        toolActivity
      ),
    [running, liveTurns, session?.turns, toolActivity]
  )

  /**
   * The last run's outcome, derived once from the evidence every other
   * surface reads: the ledger, the tool record and the run's stop reason.
   * Subscribed to the checkpoint chain so a new point, or a restore, is
   * reflected without waiting for an unrelated render.
   */
  const checkpointChain = useCoworkCheckpoints((s) =>
    session?.id ? s.bySession[session.id] : undefined
  )
  const runOutcome = useMemo(
    () =>
      deriveRunOutcome({
        running,
        stoppedBy,
        errorText: runError,
        turns: displayedTurns,
        summary: runOrigins?.summary ?? null,
        destination: runOrigins?.context.destination ?? null,
        tree:
          runOrigins?.context.tree ?? runOrigins?.context.binding.folder ?? null,
        sessionId: session?.id ?? null,
        runId: session?.id ?? null,
        finishedAt: runOrigins?.at ?? null,
        checkpoints: checkpointChain ?? [],
        openTodos: (session?.todos?.phases ?? [])
          .flatMap((phase) => phase.tasks)
          .filter((task) => task.status === 'pending' || task.status === 'in_progress')
          .length,
        handlers: {
          // Opening a file resolves against the attached folder or the
          // sandbox; a managed worktree's files are reviewed in Changes.
          openResult:
            runOrigins?.context.destination === 'repository' ||
            runOrigins?.context.destination === 'sandbox',
          reviewChanges: true,
          continue: true,
          retry: true,
        },
      }),
    [
      running,
      stoppedBy,
      runError,
      displayedTurns,
      runOrigins,
      session?.id,
      session?.todos,
      checkpointChain,
    ]
  )
  // A presentation filter: the turns themselves are untouched, so turning the
  // option off puts the activity straight back without a reload.
  const hideCompletedToolsSetting = useCoworkDisplay((s) => s.hideCompletedTools)
  // A temporary look at what is hidden. Not persisted, and reset whenever the
  // setting itself changes, so it never silently overrides the preference.
  const [revealHiddenTools, setRevealHiddenTools] = useState(false)
  useEffect(() => setRevealHiddenTools(false), [hideCompletedToolsSetting])
  const hideCompletedTools = hideCompletedToolsSetting && !revealHiddenTools
  // Converted in two halves so a streamed write re-renders only the tail.
  //
  // The committed transcript's rows do not change while a run streams, so
  // converting them apart from the live rows keeps their message identities
  // stable across every delta and `MessageItem`'s memo skips them. Tool-activity
  // reconciliation appends calls it has but the transcript does not at the end
  // of whatever it is given, so the activity list is partitioned by which half
  // owns each call before reconciling — otherwise a live call would append to
  // the committed half and jump the transcript order. AH: only-live-tail.
  const idPrefix = session?.id ?? 'cowork'
  const committedTurns = useMemo(() => {
    const base = session?.turns ?? []
    const committedCalls = new Set(
      base.filter((t) => t.role === 'tool' && t.callId).map((t) => t.callId)
    )
    const committedActivity = toolActivity.filter((item) =>
      committedCalls.has(item.call)
    )
    return reconcileToolActivity(base, committedActivity)
  }, [session?.turns, toolActivity])
  const committedMessages = useMemo(
    () =>
      coworkTurnsToUIMessages(committedTurns, idPrefix, {
        hideCompletedTools,
        omitHiddenTurns: true,
      }),
    [committedTurns, idPrefix, hideCompletedTools]
  )
  const liveRunId = useCoworkRun((s) =>
    session?.id ? s.runs[session.id]?.runId : undefined
  )
  const liveMessages = useMemo(() => {
    if (!running) return []
    const committedCalls = new Set(
      (session?.turns ?? [])
        .filter((t) => t.role === 'tool' && t.callId)
        .map((t) => t.callId)
    )
    // Only this run's record belongs to the live half: an item from an
    // earlier run whose call the transcript never kept would otherwise be
    // appended to the new turn as if this run had made it.
    const liveActivity = toolActivity.filter(
      (item) =>
        !committedCalls.has(item.call) &&
        (!liveRunId || !item.run || item.run === liveRunId)
    )
    const reconciledLive = reconcileToolActivity(liveTurns, liveActivity)
    return coworkTurnsToUIMessages(
      reconciledLive,
      idPrefix,
      { hideCompletedTools, omitHiddenTurns: true },
      committedTurns.length
    )
  }, [
    running,
    liveTurns,
    session?.turns,
    toolActivity,
    liveRunId,
    idPrefix,
    hideCompletedTools,
    committedTurns.length,
  ])
  const uiMessages = useMemo(
    () => appendLiveMessages(committedMessages, liveMessages),
    [committedMessages, liveMessages]
  )

  // A long session is drawn from its newest messages, the rest on request.
  // Drawing every message and tool card at once is what made opening a long
  // session slow; what is above the window is still in the session.
  const [earlierShown, setEarlierShown] = useState<{ sid: string | null; pages: number }>({
    sid: null,
    pages: 0,
  })
  const earlierPages = earlierShown.sid === (session?.id ?? null) ? earlierShown.pages : 0
  const messageWeights = useMemo(
    () => uiMessages.map((m) => messageWeight(m.parts as { type: string }[])),
    [uiMessages]
  )
  const windowStart = transcriptWindowStart(messageWeights, earlierPages)

  // The plan each run left, by the prompt it follows.
  const snapshotByAnchor = useMemo(
    () =>
      new Map(
        (session?.todoSnapshots ?? []).map((s) => [s.anchorId, s.list] as const)
      ),
    [session?.todoSnapshots]
  )

  // Every dispatch this session made, in order. The Nth belongs to the Nth
  // assistant message, which is how a snapshot stays with its own invocation
  // rather than being shown as a "latest" beside an older reply.
  const sessionSnapshots = useCoworkRun((s) =>
    session?.id ? s.promptSnapshots[session.id] : undefined
  )
  const snapshotByMessageId = useMemo(() => {
    const byId = new Map<string, { id: string; hash: string; redactions: number }>()
    if (!sessionSnapshots?.length) return byId
    const assistantIds = uiMessages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.id)
    assistantIds.forEach((id, i) => {
      const ref = sessionSnapshots[i]
      if (ref) byId.set(id, ref)
    })
    return byId
  }, [sessionSnapshots, uiMessages])

  const usage = liveUsage ?? session?.lastUsage ?? null
  // Cowork mirrors model loads onto useCoworkRun under the session id, so the
  // token counter (thread-keyed on useAppState) never sees them on its own.
  // Reported here so the launched context window is refetched once the load
  // finishes for this session. d901192.
  const sessionLoadingModel = useCoworkRun((s) =>
    session?.id ? Boolean(s.loadingModels[session.id]) : false
  )
  const tokenSource = useMemo(
    () => ({
      threadId: session?.id,
      // Cache counts included: the counter's popover shows them for Cowork
      // exactly as it does for Chat.
      usage: fromCoworkUsage(usage),
      contextError: stoppedBy === 'error' ? runError : undefined,
      // This session's requests only, from its own turns: how many reused the
      // cache, kept apart from how many tokens were cached.
      session: summarizeUsage(
        (session?.turns ?? []).map((turn) => fromCoworkUsage(turn.usage))
      ),
      loadingModel: sessionLoadingModel,
      // How fast this session's replies came, for the counter's hover card.
      speed: speedStats(
        (session?.turns ?? []).map((turn) => ({
          tokenSpeed: turn.tokenSpeed?.tokenSpeed,
          durationMs: turn.tokenSpeed?.durationMs,
          source: turn.tokenSpeed?.source,
          tokenCount: turn.tokenSpeed?.tokenCount ?? turn.usage?.completion_tokens,
        }))
      ),
    }),
    [session?.id, session?.turns, usage, sessionLoadingModel, stoppedBy, runError]
  )

  // Live runs write into the run store; a committed session carries its own.
  const liveSubagents = useCoworkRun((s) =>
    session?.id ? s.subagents[session.id] : undefined
  )
  // Saves the user made by hand in the Code panel, listed with the agent's.
  const userEdits = useCoworkUserEdits((s) =>
    session?.id ? (s.bySession[session.id]?.edits ?? NO_USER_EDITS) : NO_USER_EDITS
  )
  const fileDiffs = useMemo(
    () =>
      // Writes into Flint's own data folder are bookkeeping, not output.
      collectCodeFileDiffs(
        displayedTurns,
        liveSubagents ?? session?.subagents ?? [],
        userEdits
      ).filter((f) => !isFlintInternalPath(workspacePath, f.path)),
    [displayedTurns, liveSubagents, session?.subagents, userEdits, workspacePath]
  )
  return {
    fileDiffs,
    displayedTurns,
    windowStart,
    setEarlierShown,
    earlierPages,
    messageWeights,
    uiMessages,
    snapshotByAnchor,
    setRevealHiddenTools,
    snapshotByMessageId,
    runOutcome,
    tokenSource,
    checkpointChain,
  }
}
