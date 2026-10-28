import type { UIMessage } from 'ai'
import { useAppState } from '@/hooks/useAppState'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useFileActivity } from '@/hooks/useFileActivity'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import {
  recordJobCollected,
  recordShellOutcome,
  type RunContext,
} from '@/lib/coworkActivityRecorder'
import { MAX_AGENT_STEPS } from '@/lib/coworkBudget'
import type { runTurn } from '@/lib/coworkRunner'
import { renderNotices, takeNotices } from '@/lib/coworkRunNotices'
import { collectedJobId } from '@/lib/coworkTasks'
import type { CoworkChatTransport } from '@/lib/coworkTransport'
import { recordEvents } from '@/lib/eventLog'
import { usageEventPayload } from '@/lib/executionTimeline'
import { deriveFromTurns, type FileOrigin } from '@/lib/fileActivity'
import type { createMailLedger } from '@/lib/mailAutoReply'
import { agentAttribution, hasLiveSteering, takeClaimed } from '@/lib/mailboxDelivery'
import { recordPayloadUsage } from '@/lib/payloadUsage'
import type { PromptSnapshotRef } from '@/lib/providerFetch'
import type { startDeadline } from '@/lib/runDeadline'
import { generationSpeed, type createDecodeClock } from '@/lib/tokenSpeed'
import { fromCoworkUsage } from '@/lib/tokenUsage'
import { recordLifecycle } from '@/lib/toolActivity'
import { useMessageQueue } from '@/stores/message-queue-store'
import type { CoworkTurn } from '@/types/coworkSession'
import type { RunState } from './runState'

type RunTurnDeps = Parameters<typeof runTurn>[0]['deps']

/** What a run's step handlers read and write, named rather than closed over. */
export type StepHandlersContext = {
  rs: RunState
  sid: string
  runId: string
  run: RunContext
  modelId: string | undefined
  runDeadline: ReturnType<typeof startDeadline>
  transport: Pick<CoworkChatTransport, 'answering'>
  decodeClock: ReturnType<typeof createDecodeClock>
  /** Assistant rows streamed by the current step (see createStreamSink). */
  streamed: Set<CoworkTurn>
  mailLedger: ReturnType<typeof createMailLedger>
  /** This session's latest prompt snapshot. */
  latestSnapshot: () => PromptSnapshotRef | undefined
  originOfPath: (path: string) => FileOrigin
  saveInFlight: (step?: boolean) => void
  pushLive: (turns: CoworkTurn[], snapshot?: PromptSnapshotRef) => void
}

/**
 * The runner hooks a main run hands `runTurn` around each model step: settling
 * a step, binding its snapshot, naming its activity and taking steering at the
 * runner's safe boundaries.
 */
export function createStepHandlers(ctx: StepHandlersContext) {
  const { rs, sid, runId, run, decodeClock } = ctx
  const onStep: NonNullable<RunTurnDeps['onStep']> = ({ step, result, turns, outcomes }) => {
    if (result.usage)
      useCoworkRun.getState().setUsage(sid, result.usage)
    ctx.saveInFlight(true)
    // Persisted as it goes, not at the end: a run killed mid-flight
    // must not come back with its steps unspent. AH-018.
    useCoworkSessions.getState().setRunBudget(sid, {
      runId,
      steps: step,
      maxSteps: MAX_AGENT_STEPS,
      deadlineAt: ctx.runDeadline.at,
      deadlineBudgetMs: ctx.runDeadline.budgetMs,
    })
    /**
     * Bind the provider's own count to the payload it counted.
     * AH-073.
     *
     * The snapshot the transport just took carries the invocation, so
     * the exact number and the exact bytes name the same model call.
     * Without that the count is "the last request", which is a
     * different thing on every step of a long turn.
     */
    // AH-172: the request's own events in the canonical log, bound
    // to its invocation -- its usage (counts only) and what the
    // response was made of (sizes only; the words stay in the
    // transcript). One id per invocation, so a retried record is one.
    const stepInvocation = (rs.stepSnapshot ?? ctx.latestSnapshot())?.invocation
    if (stepInvocation) {
      const stepUsage = fromCoworkUsage(result.usage)
      recordEvents([
        ...(stepUsage
          ? [
              {
                id: `usage:${stepInvocation}`,
                session: sid,
                run: runId,
                invocation: stepInvocation,
                kind: 'usage.reported' as const,
                payload: usageEventPayload(stepUsage),
              },
            ]
          : []),
        {
          id: `message:${stepInvocation}`,
          session: sid,
          run: runId,
          invocation: stepInvocation,
          kind: 'message.completed' as const,
          payload: {
            textChars: result.text.length,
            toolCalls: result.toolCalls.length,
          },
        },
      ])
    }
    if (result.usage) {
      void recordPayloadUsage({
        session: sid,
        run: runId,
        snapshot: rs.stepSnapshot ?? ctx.latestSnapshot() ?? null,
        model: ctx.modelId,
        usage: result.usage,
      })
    }
    // Replace the optimistic running rows with the settled ones so the
    // transcript shows results, not spinners.
    rs.runTurns = rs.runTurns.filter(
      (turn) =>
        !(turn.role === 'tool' && outcomes.has(turn.callId ?? '')) &&
        !ctx.streamed.has(turn)
    )
    ctx.streamed.clear()
    const liveStats = useAppState.getState().liveTokenStatsByThread[sid]
    // Prefer llama.cpp's reported generation speed; otherwise derive it
    // from output tokens over the streaming span, so remote providers
    // (pxa-27b and every other non-llama.cpp model) still show a
    // tokens/sec figure -- matching what the Chat transport does.
    decodeClock.endStep()
    const stepOutputTokens =
      liveStats?.completionTokens ??
      fromCoworkUsage(result.usage)?.outputTokens ??
      0
    const generation = generationSpeed({
      serverTokensPerSecond: liveStats?.tokensPerSecond,
      outputTokens: stepOutputTokens,
      ...decodeClock.result(),
    })
    const answeredBy = ctx.transport.answering()
    const settledTurns = turns.map((turn0) => {
      const turn =
        answeredBy && turn0.role === 'assistant' && !turn0.assistant
          ? { ...turn0, assistant: answeredBy }
          : turn0
      return turn.role === 'assistant' &&
      turn.content === result.text &&
      generation
        ? {
            ...turn,
            tokenSpeed: {
              tokenSpeed: generation.tokenSpeed,
              promptSpeed: liveStats?.promptPerSecond ?? undefined,
              tokenCount: generation.tokenCount,
              durationMs: generation.durationMs,
              source: generation.source,
            },
          }
        : turn
    })
    // Reset the generation span so the next step measures its own.
    decodeClock.reset()
    ctx.pushLive(settledTurns, rs.stepSnapshot ?? ctx.latestSnapshot())
    // Record this step's file work now. Ids are keyed on the tool
    // call, so the commit re-recording the same rows is a no-op rather
    // than a duplicate.
    useFileActivity
      .getState()
      .record(sid, deriveFromTurns(turns, ctx.originOfPath, Date.now()))
    for (const [callId, outcome] of outcomes) {
      if (outcome.diff) {
        useToolCallRuntime.getState().recordDiff(callId, outcome.diff)
      }
      const turn = turns.find(
        (one) => one.role === 'tool' && one.callId === callId
      )
      if (turn?.name !== 'bash') continue
      // A collecting call settles the command it collects, which is a
      // different row; a plain call settles its own.
      const collecting = collectedJobId(turn.args)
      if (collecting) recordJobCollected(sid, collecting, outcome)
      else recordShellOutcome(run, callId, outcome)
      recordEvents([
        {
          id: `job:${collecting ?? callId}:ended:${callId}`,
          session: sid,
          run: runId,
          kind: 'job.ended',
          payload: { tool: 'bash', status: outcome.isError ? 'failed' : 'succeeded' },
        },
      ])
    }
  }
  const onResponse = () => {
    rs.stepSnapshot = ctx.latestSnapshot()
  }
  const activity = () => ({
    session: sid,
    run: runId,
    agent: 'main',
    invocation: rs.stepSnapshot?.invocation,
  })
  // janhq/jan#8864. What the user chose to steer with from this
  // session's composer while the run worked (Steer now, Ctrl+Enter),
  // taken at the runner's safe boundaries. Only this
  // session's queue: input typed in another session never reaches
  // this run, whichever session is in view. Shown in the transcript
  // where it entered the conversation, marked as steering.
  const hasSteering = () => hasLiveSteering(sid)
  const takeSteering = async () => {
    // Mail a tool already consumed (wait_for_reply, read_messages)
    // is dropped here, so it is never injected a second time.
    const taken = await takeClaimed(sid, () =>
      // Only what the user chose to steer with (and mail). Plain
      // queued input waits and goes as its own turn after the run.
      useMessageQueue.getState().takeSteering(sid)
    )
    // App notices (a background subagent finished or asked) ride along
    // at the same boundary, as one fenced block.
    const notices = takeNotices(sid)
    const noticeMessages = notices.length
      ? [
          {
            id: `${sid}-notice-${Date.now().toString(36)}`,
            role: 'user',
            parts: [{ type: 'text', text: renderNotices(notices) }],
          } as UIMessage,
        ]
      : []
    if (taken.length === 0) return noticeMessages
    for (const m of taken) ctx.mailLedger.note(m.from)
    // Into this run's execution record, in sequence with its calls:
    // steering changes what the model works from. The words stay in
    // the transcript; the record says only that input was delivered.
    for (const m of taken) {
      void recordLifecycle(
        { session: sid, run: runId, source: 'cowork' },
        {
          id: `steer:${runId}:${m.id}`,
          lifecycle: 'steering',
          phase: 'succeeded',
          summary: 'Input delivered to the running agent',
        }
      )
    }
    ctx.pushLive(
      taken.map((m) => ({
        role: 'user' as const,
        content: m.text,
        steered: true,
        at: m.createdAt ?? Date.now(),
        // A mailbox message keeps its sender, so the transcript can
        // say who it came from and offer a reply.
        ...(m.from ? { from: agentAttribution(m.from) } : {}),
      }))
    )
    return [
      ...noticeMessages,
      ...taken.map(
        (m) =>
          ({
            id: `${sid}-steer-${m.id}`,
            role: 'user',
            parts: [{ type: 'text', text: m.text }],
          }) as UIMessage
      ),
    ]
  }
  return { onStep, onResponse, activity, hasSteering, takeSteering }
}
