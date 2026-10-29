import {
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'
import { useCoworkSessions, startPaneSession } from '@/hooks/useCoworkSessions'
import { useSplitConversation } from '@/hooks/useSplitConversation'
import type { AskAnswer, Usage } from '@/types/coworkSession'
import { useMessageQueue } from '@/stores/message-queue-store'
import { recordLifecycle } from '@/lib/toolActivity'
import { type SubmittedFile } from '@/lib/coworkAttachments'
import { configuredContextTokens } from '@/lib/coworkContextWindow'
import { compactHistory, DEFAULT_KEEP_RECENT } from '@/lib/compaction'
import { manualSummarizer } from '@/lib/compactionSummarizer'
import { CompactionSummaryError, estimateHistoryTokens } from '@/lib/compaction'
import { fixedPromptTokens } from '@/lib/contextBreakdown'
import { useContextBreakdown } from '@/hooks/useContextBreakdown'
import {
  getCompactionPolicy,
  DEFAULT_COMPACTION_POLICY,
  type CompactionPolicy,
} from '@/lib/compactionPolicy'
import { holdQueueThenStop } from '@/lib/chatSteering'
import { largestAcceptedPrompt } from '@/lib/cowork/run/runRequest'
import { useSavedWorkflowBuiltins } from '@/hooks/useSavedWorkflowBuiltins'
import {
  abortRun,
  abortAll,
  answerAsk,
} from '@/lib/coworkRunner'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { ModelCapabilities } from '@/lib/modelCapabilities'
import type { RefObject } from 'react'
import type { QueuedMessageSender } from '@/stores/message-queue-store'
import type { CoworkAttachmentInput } from '@/lib/coworkAttachments'

export type CoworkRunActionsArgs = {
  session: CoworkSession | null
  running: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the store's own type
  selectedModel: any
  selectedProvider: string
  modelCapabilities: ModelCapabilities
  t: (key: string, options?: Record<string, unknown>) => string
  runRequestRef: RefObject<(text: string | null, from?: QueuedMessageSender | undefined, hidden?: boolean | undefined, attachmentInput?: CoworkAttachmentInput | undefined, onRefused?: (() => void) | undefined) => Promise<void>>
  handleSubmit: (text: string, files?: SubmittedFile[], onRefused?: () => void) => void
  sidePaneIdRef: RefObject<string | undefined>
  paneSessionIdRef: RefObject<string | undefined>
}

export function useCoworkRunActions({
  session,
  running,
  selectedModel,
  selectedProvider,
  modelCapabilities,
  t,
  runRequestRef,
  handleSubmit,
  sidePaneIdRef,
  paneSessionIdRef,
}: CoworkRunActionsArgs) {
  // Cowork's own `/` built-ins; `/help` is added by the composer.
  /**
   * Compact this session now: fold its older messages into a summary written
   * by the session's model, keep the recent turns, and persist the result so
   * every later request sends the compacted history. Works whether or not
   * Auto Compact is on; that switch only decides whether it happens by itself.
   */
  const [compacting, setCompacting] = useState(false)
  const compactNow = async (opts: { thenContinue?: boolean } = {}) => {
    const sid = session?.id
    if (!sid || running || compacting || !selectedModel) return
    const cur = useCoworkSessions
      .getState()
      .sessions.find((one) => one.id === sid)
    if (!cur) return
    let policy: CompactionPolicy = DEFAULT_COMPACTION_POLICY
    try {
      policy = await getCompactionPolicy(cur.folder ?? null)
    } catch {
      // Defaults: a manual compaction was asked for either way.
    }
    setCompacting(true)
    const snapshot = cur.messages
    try {
      const summarizer = manualSummarizer({
        provider: selectedProvider,
        modelId: selectedModel.id,
        session: sid,
        maxOutputTokens: policy.summaryMaxTokens,
        window: configuredContextTokens(
          modelCapabilities,
          largestAcceptedPrompt(cur.turns)
        ),
      })
      let result: Awaited<ReturnType<typeof compactHistory>>
      try {
        result = await compactHistory(cur.messages ?? [], {
          summarize: summarizer.summarize,
          keepRecent: policy.keepRecent || DEFAULT_KEEP_RECENT,
          reason: 'manual',
          // Never swap the conversation for a first-line digest unasked.
          fallback: false,
          summarizedBy: summarizer.usedBy,
        })
      } catch (error) {
        if (!(error instanceof CompactionSummaryError)) throw error
        toast.error(t('common:budget.compactFailedReason', { reason: error.reason }))
        return
      }
      if (!result) {
        toast.info(t('common:budget.compactFailed'))
        return
      }
      // A message sent while the summary was being written changed the
      // history: committing the summary would silently drop that exchange.
      const latest = useCoworkSessions
        .getState()
        .sessions.find((one) => one.id === sid)
      if (latest?.messages !== snapshot) {
        toast.info(t('common:budget.compactSuperseded'))
        return
      }
      // The counter reads the last reply's usage, which described the long
      // history. Until the next reply it shows what the compacted request
      // will carry: the summary and kept turns plus the fixed prompt.
      const estimated =
        estimateHistoryTokens(result.messages) +
        fixedPromptTokens(useContextBreakdown.getState().byId[sid])
      useCoworkSessions
        .getState()
        .commitTurns(
          sid,
          [{ role: 'assistant', content: '', compaction: result.record }],
          result.messages,
          [],
          {
            prompt_tokens: estimated,
            completion_tokens: 0,
            total_tokens: estimated,
          } as Usage
        )
      const committed = useCoworkSessions
        .getState()
        .sessions.find((one) => one.id === sid)?.messages
      toast.success(
        t('common:budget.compactDone', { model: result.record.model ?? '' }),
        {
          action: {
            label: t('common:budget.compactUndo'),
            onClick: () => {
              const now = useCoworkSessions
                .getState()
                .sessions.find((one) => one.id === sid)
              // Only while nothing was sent since: otherwise it would drop it.
              if (now?.messages !== committed) {
                toast.info(t('common:budget.compactUndoStale'))
                return
              }
              useCoworkSessions.setState((st) => ({
                sessions: st.sessions.map((one) =>
                  one.id === sid ? { ...one, messages: snapshot } : one
                ),
              }))
            },
          },
        }
      )
      void recordLifecycle(
        { session: sid, run: '', source: 'cowork' },
        {
          id: `compaction:manual:${result.record.at}`,
          lifecycle: 'compaction',
          phase: 'succeeded',
          summary: `Compacted ${result.record.summarizedCount} messages into a summary`,
        }
      )
      // From the stop card: the run stopped for room, so it resumes on it.
      if (opts.thenContinue) void runRequestRef.current('Continue.', undefined, true)
    } finally {
      setCompacting(false)
    }
  }
  const compactNowRef = useRef(compactNow)
  compactNowRef.current = compactNow

  const savedWorkflowBuiltins = useSavedWorkflowBuiltins(
    useCallback((text: string) => void handleSubmit(text), [handleSubmit])
  )
  const slashBuiltins = useMemo(
    () => [
      {
        name: 'compact',
        description: t('slash:builtin.compact'),
        run: () => void compactNowRef.current(),
      },
      {
        name: 'new',
        description: t('slash:builtin.newSession'),
        run: () => {
          // Same rule as the sidebar's entry point: one press, at most one
          // session. The composer's text is the `/new` being consumed, so it
          // is no draft.
          const paneId = sidePaneIdRef.current
          const paneSid = paneSessionIdRef.current
          if (paneId && paneSid) {
            // Typed in a pane beside the main one: the new session opens in
            // that pane, and the main pane keeps what it shows.
            const id = startPaneSession(paneSid, { running })
            useSplitConversation
              .getState()
              .setPaneTarget(paneId, { kind: 'cowork', refId: id })
            return
          }
          const store = useCoworkSessions.getState()
          const id = store.startSession({ running })
          store.selectSession(id)
        },
      },
      ...savedWorkflowBuiltins,
    ],
    [t, running, savedWorkflowBuiltins, paneSessionIdRef, sidePaneIdRef]
  )

  /**
   * Take the last turn again. Rewinding to the question and resuming is the
   * whole operation — an agent turn is a chain of tool calls, so regenerating
   * means discarding that chain, not re-sending the question after it.
   */
  const handleRegenerate = useCallback(() => {
    if (running || !session?.id) return
    useCoworkSessions.getState().rewindToLastUser(session.id)
    void runRequestRef.current(null)
  }, [running, session?.id, runRequestRef])

  // Stop reaches the viewed session's run and nothing else: its model stream,
  // its tool loop, its subagents and its open questions (janhq/jan#8905). It
  // used to abort whichever run had started last, in any session.
  // What is queued is held, not cleared, for the user to send or discard.
  const handleStop = useCallback(() => {
    const sid = session?.id
    if (sid) holdQueueThenStop([sid], () => abortRun(sid))
  }, [session?.id])

  // "Stop all activity": abort every session's renderer-side run loop. The
  // backend emergency-stop ({}) that runs alongside only reaps subprocess
  // Tokens and cannot reach these JS AbortControllers, so without this the
  // model streams and tool loops keep going after the user asked to stop.
  const handleStopAll = useCallback(() => {
    holdQueueThenStop(Object.keys(useMessageQueue.getState().queues), abortAll)
  }, [])

  // The run's real id (a per-run UUID), not the session id, is what the backend
  // Tokens are scoped under. Passing the session id here made the scoped
  // stop-current match no Token (janhq/jan#8905 scope check requires an exact
  // run match), so only the local abort did anything.
  const currentRunId = useCoworkRun((s) =>
    session?.id ? s.runs[session.id]?.runId : undefined
  )

  // Answered through the session that asked; another session's questions are
  // not reachable from here.
  const respondAsk = useCallback(
    (requestId: string, answers: AskAnswer[] | null) => {
      if (session?.id) answerAsk(session.id, requestId, answers)
    },
    [session?.id]
  )
  return {
    setCompacting,
    handleStop,
    handleRegenerate,
    respondAsk,
    compactNow,
    compacting,
    slashBuiltins,
    currentRunId,
    handleStopAll,
    compactNowRef,
  }
}
