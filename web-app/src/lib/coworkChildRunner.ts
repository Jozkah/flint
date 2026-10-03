/**
 * Run one subagent child and record it.
 *
 * This is the part of delegation that does not depend on where the parent is
 * running: resolve the definition, make sure there is a model, record the
 * dispatch, chain the child's cancellation to the run's (and to a team's),
 * stream its events into the activity record the Tasks panel reads, and settle
 * how it ended. The parts that do depend on the surface — which folder the
 * child sees, which grant it holds, how its tool calls are gated and where an
 * approval is shown — arrive through `setup`.
 *
 * Cowork builds it once per run; plain chat and Rooms build it with their own
 * `setup`. All three share one set of rules for a child's records, its Stop and
 * its result, so a fix to one is a fix to all of them.
 *
 * Extracted from `routes/cowork.tsx` (`dispatchChild`); the behaviour there is
 * unchanged.
 */
import type { LanguageModel, Tool } from 'ai'
import { applyInnerToTurns, type StreamEvent } from '@/hooks/useCoworkRun'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { recordEvents } from '@/lib/eventLog'
import { CANCELLED_BY_USER } from '@/lib/coworkCancel'
import { taskIdFor } from '@/lib/coworkActivity'
import { recordAgentDispatch, type RunContext } from '@/lib/coworkActivityRecorder'
import { registerSubagent, unregisterSubagent, type ToolOutcome } from '@/lib/coworkRunner'
import {
  parentToolNames,
  resolveSubagent,
  runSubagent,
  type ResolvedSubagent,
  type RunSubagentOptions,
  type SubagentRequest,
} from '@/lib/coworkSubagent'
import type { SubagentDefinition } from '@/lib/coworkSubagentRegistry'
import { countToolCalls } from '@/lib/coworkTasks'
import { recordToolActivity, type ToolActivityContext } from '@/lib/toolActivity'
import type { Destination } from '@/lib/coworkTeamDestinations'
import type { CoworkTurn, Usage } from '@/types/coworkSession'

/** How a surface gates, informs and attributes one child. */
export type ChildSetup = {
  /** The workspace facts the child's system prompt carries. */
  system: RunSubagentOptions['system']
  /** Runs one of the child's tool calls under the surface's own gate. */
  dispatch: RunSubagentOptions['dispatch']
  /** Who the child's calls are recorded as. */
  activity: () => ToolActivityContext
}

/** The transcript lane a surface keeps for its children, when it keeps one. */
export type ChildLane = {
  queue(callId: string, name: string, waiting: number): void
  start(callId: string, name: string): void
  inner(callId: string, event: StreamEvent): void
  /** The child's turns so far, as the lane holds them. */
  turns(callId: string): CoworkTurn[] | undefined
  end(callId: string, usage: Usage | null): void
  attach(callId: string, output: string): void
}

export type ChildRunnerEnv = {
  sessionId: string
  runId: string
  run: RunContext
  /** The parent's model id, recorded on each child's task. */
  modelId: string
  definitions: SubagentDefinition[]
  /** Stopping the run stops every child it started. */
  signal: AbortSignal
  /** The parent's model instance. A second one would be a second load. */
  model: () => LanguageModel | null | undefined
  providerOptions: () => RunSubagentOptions['providerOptions']
  /** The tools the parent advertised; a child gets these, narrowed. */
  parentTools: () => Record<string, Tool>
  anchorMessageId: () => string | undefined
  setup: (resolved: ResolvedSubagent, destination?: Destination) => ChildSetup
  lane?: ChildLane
  /** Which surface the queued-for-a-slot line is recorded under. */
  activitySource?: 'cowork' | 'chat'
  /** Per-child step budget, when the surface wants less than the default. */
  maxSteps?: number
  /**
   * Tokens a surface has already spent, so a child cannot outrun the budget the
   * surface still has: the run's own cap applies from here, and a child that
   * starts at the cap stops before it begins.
   */
  startingTokens?: () => number
  /** Told how many tokens each finished child used, for a surface that keeps a
   * budget of its own (a Room). */
  onUsage?: (usage: Usage | null) => void
}

export type ChildRunner = (
  callId: string,
  req: SubagentRequest,
  teamSignal?: AbortSignal,
  parentTaskId?: string,
  destination?: Destination
) => Promise<ToolOutcome>

export function createChildRunner(env: ChildRunnerEnv): ChildRunner {
  return async (callId, req, teamSignal, parentTaskId, destination) => {
    const resolved = resolveSubagent(
      req,
      env.definitions,
      parentToolNames(env.parentTools())
    )
    if ('error' in resolved) {
      return { output: `ERROR: ${resolved.error}`, isError: true }
    }
    const model = env.model()
    if (!model) {
      return {
        output: 'ERROR: no model is loaded for this run, so no subagent can start',
        isError: true,
      }
    }
    // Recorded before the child starts: the dispatch is the only moment the
    // agent name, description and model are known together, and the record has
    // to exist for the queue position that arrives next to land on something.
    recordEvents([
      {
        id: `agent:${env.run.runId}:${callId}:dispatched`,
        session: env.run.sessionId,
        run: env.run.runId,
        kind: 'agent.dispatched',
        payload: {
          agent: resolved.name,
          model: env.modelId,
          description: req.description,
        },
      },
    ])
    recordAgentDispatch(env.run, {
      callId,
      agentName: resolved.name,
      description: req.description,
      model: env.modelId,
      // A team's children hang under the team's own row, so the panel shows one
      // piece of work with parts rather than several unrelated errands.
      parentTaskId,
      anchorMessageId: env.anchorMessageId(),
      background: req.background === true || parentTaskId !== undefined,
    })
    // Its own controller, chained to the run's, so this one child can be
    // stopped without stopping the turn.
    const childTaskId = taskIdFor(env.sessionId, env.runId, callId)
    const childAbort = registerSubagent(env.sessionId, childTaskId)
    const stopChild = () => childAbort.abort('cancelled')
    env.signal.addEventListener('abort', stopChild, { once: true })
    // A team cancels its children through their own signals, so one task can be
    // stopped without stopping the turn. Chained rather than replacing the
    // run's: both must be able to end this child.
    if (teamSignal) {
      if (teamSignal.aborted) childAbort.abort('cancelled')
      else teamSignal.addEventListener('abort', stopChild, { once: true })
    }
    const activity = useCoworkActivity.getState()
    /**
     * Record how this child actually ended.
     *
     * A child stopped by the run's own Stop is cancelled, not failed: the abort
     * is why it ended. Anything already settled — the panel's per-task Stop
     * writes `cancelled` first — keeps the status it has, because the guard in
     * `updateTask` refuses to overwrite a finished one.
     */
    const settleChild = (
      isError: boolean,
      output?: string,
      flags?: { capped?: boolean; stoppedAtLimit?: boolean }
    ) => {
      const aborted = childAbort.signal.aborted
      useCoworkActivity.getState().patchTask(childTaskId, {
        ...(output != null ? { output } : {}),
        ...(flags?.capped ? { resultCapped: true } : {}),
        ...(flags?.stoppedAtLimit ? { stoppedAtLimit: true } : {}),
        status: aborted
          ? ('cancelled' as const)
          : isError
            ? ('error' as const)
            : ('done' as const),
        endedAt: Date.now(),
        ...(aborted ? { detail: CANCELLED_BY_USER } : {}),
      })
    }
    // The child's own trace, for a surface with no transcript lane of its own.
    let localTurns: CoworkTurn[] = []
    try {
      const setup = env.setup(resolved, destination)
      const child = await runSubagent({
        resolved,
        description: req.description,
        // The same identity the child's dispatched calls carry, for the calls
        // the runner refuses without dispatching.
        activity: setup.activity,
        model,
        providerOptions: env.providerOptions(),
        parentTools: env.parentTools(),
        system: setup.system,
        signal: childAbort.signal,
        sessionTokens: env.startingTokens?.() ?? 0,
        ...(env.maxSteps ? { maxSteps: env.maxSteps } : {}),
        dispatch: setup.dispatch,
        events: {
          onQueued: (waiting) => {
            // The dispatching call's item says it is waiting for a slot, in
            // sequence with everything else the run did.
            void recordToolActivity({
              call: callId,
              tool: 'task',
              session: env.sessionId,
              run: env.runId,
              agent: 'main',
              source: env.activitySource ?? 'cowork',
              phase: 'queued',
              detail: `waiting for a slot (position ${waiting})`,
            })
            env.lane?.queue(callId, resolved.name, waiting)
            activity.patchTask(childTaskId, { status: 'queued', waiting })
          },
          onStart: () => {
            env.lane?.start(callId, resolved.name)
            activity.patchTask(childTaskId, {
              status: 'running',
              waiting: undefined,
              startedAt: Date.now(),
            })
          },
          onInner: (event) => {
            env.lane?.inner(callId, event)
            // Mirrored onto the record so the panel can show the child's own
            // trace without reaching into the run store.
            let turns: CoworkTurn[] | undefined
            if (env.lane) {
              turns = env.lane.turns(callId)
            } else {
              localTurns = applyInnerToTurns(localTurns, event)
              turns = localTurns
            }
            if (turns) {
              activity.patchTask(childTaskId, {
                transcript: turns,
                toolCount: countToolCalls(turns),
              })
            }
          },
          onEnd: (usage) => {
            env.lane?.end(callId, usage)
            // Usage only. `onEnd` fires for *every* ending — an abort before the
            // child even starts, a failed model step, an exhausted step budget —
            // so writing a terminal status here would record every one of them
            // as success, and the finished-status guard would then refuse the
            // real outcome that arrives a moment later.
            activity.patchTask(childTaskId, { usage: usage ?? undefined })
            env.onUsage?.(usage)
          },
        },
      })
      env.lane?.attach(callId, child.output)
      settleChild(Boolean(child.isError), child.output, {
        capped: child.capped,
        stoppedAtLimit: child.stoppedAtLimit,
      })
      return {
        output: child.output,
        isError: child.isError,
        ...(child.full ? { full: child.full } : {}),
      }
    } finally {
      env.signal.removeEventListener('abort', stopChild)
      unregisterSubagent(env.sessionId, childTaskId)
      // A throw from the dispatch would otherwise leave the record running with
      // nothing left to finish it.
      settleChild(true)
    }
  }
}
