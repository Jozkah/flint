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
import type { LanguageModel, Tool, UIMessage } from 'ai'
import { applyInnerToTurns, type StreamEvent } from '@/hooks/useCoworkRun'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { recordEvents } from '@/lib/eventLog'
import { CANCELLED_BY_USER } from '@/lib/coworkCancel'
import { taskIdFor } from '@/lib/coworkActivity'
import { recordAgentDispatch, type RunContext } from '@/lib/coworkActivityRecorder'
import {
  registerSubagent,
  unregisterSubagent,
  type PendingToolCall,
  type ToolOutcome,
} from '@/lib/coworkRunner'
import {
  parentToolNames,
  resolveSubagent,
  runSubagent,
  subagentTools,
  type ResolvedSubagent,
  type RunSubagentOptions,
  type SubagentRequest,
} from '@/lib/coworkSubagent'
import type { SpawnLimits } from '@/lib/coworkSubagent'
import type { SubagentDefinition } from '@/lib/coworkSubagentRegistry'
import { countToolCalls } from '@/lib/coworkTasks'
import {
  ASK_PARENT_TOOL_NAME,
  askParent,
  askParentTool,
  renderAnswerForChild,
} from '@/lib/coworkSubagentQuestions'
import {
  recallSubagent,
  rememberSubagent,
  resumeHint,
} from '@/lib/coworkSubagentHistory'
import { recordToolActivity, type ToolActivityContext } from '@/lib/toolActivity'
import type { Destination } from '@/lib/coworkTeamDestinations'
import {
  AGENT_MEMORY_TOOL_NAME,
  agentMemoryTool,
  defaultMemoryDeps,
  memoryBlock,
  memoryLaunchError,
  runMemoryWrite,
  type MemoryDeps,
  type MemoryScope,
} from '@/lib/coworkSubagentMemory'
import { currentSubagentSettings } from '@/hooks/useSubagentSettings'
import { clampMaxConcurrent, clampMaxDepth } from '@/lib/subagentSettings'
import { checkLaunch, type LaunchInfo } from '@/lib/coworkSubagentLaunchGate'
import type { CoworkMode } from '@/lib/coworkMode'
import { labelSubagentOutput } from '@/lib/coworkSubagentSafety'
import { errandLine, joinRoster, rosterBlock } from '@/lib/coworkSubagentRoster'
import { preloadSkills } from '@/lib/coworkSubagentSkills'
import { resolveChildEffort } from '@/lib/coworkSubagentEffort'
import { prepareChildChoice, profileLabel, type ParentPersona } from '@/lib/subagentChoice'
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
  /** The parent's provider, so an unchanged model is recognised as the parent's. */
  providerId?: string
  /** The parent's own assistant and work profile, for children that inherit them. */
  parent?: () => ParentPersona | undefined
  definitions: SubagentDefinition[]
  /** Stopping the run stops every child it started. */
  signal: AbortSignal
  /** The parent's model instance. A second one would be a second load. */
  model: () => LanguageModel | null | undefined
  /** Whether the parent's model reads images, so a child's tool results may carry them. */
  supportsVision?: () => boolean
  providerOptions: () => RunSubagentOptions['providerOptions']
  /** The tools the parent advertised; a child gets these, narrowed. */
  parentTools: () => Record<string, Tool>
  anchorMessageId: () => string | undefined
  /**
   * `spawn` is this child's place in the spawn tree; a surface that lets
   * children nest routes their `task` calls back into the runner one level down.
   */
  setup: (
    resolved: ResolvedSubagent,
    destination?: Destination,
    spawn?: SpawnLimits
  ) => ChildSetup
  lane?: ChildLane
  /** Which surface the queued-for-a-slot line is recorded under. */
  activitySource?: 'cowork' | 'chat'
  /** Per-child step budget, when the surface wants less than the default. */
  maxSteps?: number
  /**
   * The most tokens a child may spend, for a surface that keeps a budget of its
   * own: a child that reaches it stops with the token-budget status.
   */
  tokenLimit?: () => number | undefined
  /**
   * Asks the user before a subagent writes its persistent memory. Absent means
   * the surface cannot ask, and the write is refused.
   */
  approveMemoryWrite?: (info: {
    agent: string
    scope: MemoryScope
    content: string
    signal: AbortSignal
  }) => Promise<boolean>
  /**
   * The one-time question before an editing subagent first runs in a session.
   * Absent means the surface asks nothing up front.
   */
  launchGate?: {
    /** The mode this child would run in, or undefined when unknown. */
    mode: (resolved: ResolvedSubagent) => CoworkMode | undefined
    ask: (info: LaunchInfo & { signal: AbortSignal }) => Promise<boolean>
  }
  /**
   * What a forked subagent inherits: the conversation the run started this turn
   * with (prior turns and the message that began it) and the system prompt the
   * parent sends. Absent where a surface cannot fork.
   */
  fork?: { history: () => UIMessage[]; system: () => string }
  /** Test seam for the memory commands. */
  memoryDeps?: MemoryDeps
  /** Told how many tokens each finished child used, for a surface that keeps a
   * budget of its own (a Room). */
  onUsage?: (usage: Usage | null) => void
}

export type ChildRunner = (
  callId: string,
  req: SubagentRequest,
  teamSignal?: AbortSignal,
  parentTaskId?: string,
  destination?: Destination,
  /** The team task id the checkout's review is listed under. */
  checkoutTaskId?: string,
  /** The depth of whoever is asking: 0 for the main agent, 1 for its child. */
  callerDepth?: number
) => Promise<ToolOutcome>

/** Why a fork cannot start here, or null when it can. Pure. */
export function forkRefusal(f: {
  /** The surface offers forking at all. */
  available: boolean
  /** Asked to run in the background or under a team. */
  background: boolean
  callerDepth: number
  resuming: boolean
}): string | null {
  if (!f.available) return 'fork is not available on this surface'
  if (f.background) return 'a forked subagent runs in the foreground only'
  if (f.callerDepth > 0) return 'a subagent cannot fork'
  if (f.resuming) return 'a fork cannot be resumed'
  return null
}

/**
 * Which model, assistant and work profile a child runs with: the Subagents
 * settings over the parent's (lib/subagentSettings.ts), and its own model
 * instance when the call or the definition asks for a reasoning effort. A fork
 * keeps the parent's model and effort. Tools and approvals are not part of it.
 */
export async function resolveChildConfig(
  env: Pick<ChildRunnerEnv, 'providerId' | 'modelId' | 'parent'>,
  resolved: Pick<ResolvedSubagent, 'name' | 'effort'>,
  req: Pick<SubagentRequest, 'model'>,
  forking: boolean
) {
  const choice = await prepareChildChoice({
    role: resolved.name,
    parentModel: { provider: env.providerId ?? '', id: env.modelId },
    parent: env.parent?.(),
    requestedModel: forking ? undefined : req.model,
  })
  let effortChoice: Awaited<ReturnType<typeof resolveChildEffort>> | undefined
  if (!forking && resolved.effort && choice.providerId) {
    effortChoice = await resolveChildEffort({
      providerId: choice.providerId,
      modelId: choice.modelId,
      level: resolved.effort,
    })
    if ('note' in effortChoice && effortChoice.note) {
      choice.note = [choice.note, effortChoice.note].filter(Boolean).join('; ')
    }
  }
  return { choice, effortChoice }
}

/**
 * An editing child, foreground, in a mode that would ask: one question first.
 * True when it may start (no gate on this surface, or the user approved).
 */
export async function askEditingChildApproval(
  env: Pick<ChildRunnerEnv, 'launchGate' | 'sessionId' | 'parentTools' | 'signal'>,
  resolved: ResolvedSubagent,
  launch: { spawn: SpawnLimits; model: string; foreground: boolean }
): Promise<boolean> {
  const gate = env.launchGate
  if (!gate) return true
  return checkLaunch({
    sessionId: env.sessionId,
    agent: resolved.name,
    mode: gate.mode(resolved),
    tools: Object.keys(subagentTools(env.parentTools(), resolved.allowedTools, launch.spawn)),
    model: launch.model,
    foreground: launch.foreground,
    ask: (info) => gate.ask({ ...info, signal: env.signal }),
  })
}

export function createChildRunner(env: ChildRunnerEnv): ChildRunner {
  return async (callId, req, teamSignal, parentTaskId, destination, checkoutTaskId, callerDepth = 0) => {
    const limits = currentSubagentSettings()
    const spawn: SpawnLimits = {
      depth: callerDepth + 1,
      // A fork never spawns, whatever the depth setting allows.
      maxDepth: req.fork ? callerDepth + 1 : clampMaxDepth(limits.maxDepth),
    }
    const maxConcurrent = clampMaxConcurrent(limits.maxConcurrent)
    // A follow-up runs as the agent that finished, on what it already knows.
    const resumeId = req.resume_agent_id
    const remembered = resumeId
      ? recallSubagent(env.sessionId, resumeId)
      : undefined
    if (resumeId && !remembered) {
      return {
        output:
          `ERROR: no finished subagent has the id '${resumeId}' in this session. ` +
          'Only a subagent that finished in this session can be resumed, and only until the app restarts; start a new one with a full brief instead.',
        isError: true,
      }
    }
    if (remembered) req = { ...req, subagent_name: remembered.name }
    const resolved = resolveSubagent(
      req,
      env.definitions,
      parentToolNames(env.parentTools())
    )
    if ('error' in resolved) {
      return { output: `ERROR: ${resolved.error}`, isError: true }
    }
    const forking = resolved.fork === true
    if (forking) {
      const why = forkRefusal({
        available: Boolean(env.fork),
        background: Boolean(req.background) || parentTaskId !== undefined,
        callerDepth,
        resuming: Boolean(resumeId),
      })
      if (why) return { output: `ERROR: ${why}`, isError: true }
    }
    const model = env.model()
    if (!model) {
      return {
        output: 'ERROR: no model is loaded for this run, so no subagent can start',
        isError: true,
      }
    }
    const { choice, effortChoice } = await resolveChildConfig(env, resolved, req, forking)
    const approved = await askEditingChildApproval(env, resolved, {
      spawn,
      model: choice.modelId,
      foreground: req.background !== true && parentTaskId === undefined,
    })
    if (!approved) {
      return {
        output: `Subagent '${resolved.name}' was not started: the user did not approve running it with editing tools.`,
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
          model: choice.modelId,
          description: req.description,
        },
      },
    ])
    recordAgentDispatch(env.run, {
      callId,
      agentName: resolved.name,
      title: req.title,
      phase: req.phase,
      description: req.description,
      model: choice.modelId,
      // A team's children hang under the team's own row, so the panel shows one
      // piece of work with parts rather than several unrelated errands.
      parentTaskId,
      anchorMessageId: env.anchorMessageId(),
      background: req.background === true || parentTaskId !== undefined,
    })
    // Its own controller, chained to the run's, so this one child can be
    // stopped without stopping the turn.
    const childTaskId = taskIdFor(env.sessionId, env.runId, callId)
    // Said on the record, now that it exists: a patch made before the dispatch
    // is recorded lands on nothing. The row then shows where this child works
    // and leads to its review.
    if (destination) {
      useCoworkActivity.getState().patchTask(childTaskId, {
        detail: `own checkout: ${destination.path}`,
        checkout: {
          path: destination.path,
          branch: destination.branch,
          taskId: checkoutTaskId ?? callId,
        },
      })
    }
    if (choice.assistant || choice.profile || choice.note) {
      useCoworkActivity.getState().patchTask(childTaskId, {
        ...(choice.assistant ? { assistant: choice.assistant.name } : {}),
        ...(choice.profile ? { profile: profileLabel(choice.profile) } : {}),
        ...(choice.inherited.assistant || choice.inherited.profile
          ? {
              inherited: [
                ...(choice.inherited.assistant ? ['assistant' as const] : []),
                ...(choice.inherited.profile ? ['profile' as const] : []),
              ],
            }
          : {}),
        ...(choice.note ? { detail: choice.note } : {}),
      })
    }
    // The children of this run already going, told to the one starting now.
    const roster = joinRoster(env.runId, callId, {
      name: resolved.name,
      errand: errandLine(req.title, req.description),
    })
    const siblingBlock = rosterBlock(roster.siblings)
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
    const askable = req.background === true && parentTaskId === undefined
    try {
      const built = env.setup(resolved, destination, spawn)
      // A definition that omits instructions hands its child none: neither the
      // `JAN.md` nor the compatibility files the parent was given.
      const setup = resolved.omitInstructions
        ? {
            ...built,
            system: {
              ...built.system,
              projectInstructions: null,
              compatInstructions: [],
            },
          }
        : built
      // Skills the definition preloads: read through the child's own dispatcher,
      // so a missing or model-invocation-disabled one fails the launch by name.
      const preloaded = resolved.skills?.length
        ? await preloadSkills(resolved.skills, setup.dispatch, childAbort.signal)
        : { blocks: [] as string[] }
      if ('error' in preloaded) {
        const message = `ERROR: subagent '${resolved.name}' not started: ${preloaded.error}`
        env.lane?.attach(callId, message)
        settleChild(true, message)
        return { output: message, isError: true }
      }
      // Persistent memory: its first lines go into the child's context and it
      // gets one write tool, scoped to its own MEMORY.md and gated by the user.
      let memoryBlockText: string | undefined
      const memoryScope = resolved.memory
      const memoryRoot = setup.system.readOnlyFolder ?? setup.system.workspacePath ?? null
      if (memoryScope) {
        const why = memoryLaunchError(memoryScope, memoryRoot)
        let loaded: Awaited<ReturnType<MemoryDeps['load']>> | undefined
        if (!why) {
          try {
            loaded = await (env.memoryDeps ?? defaultMemoryDeps).load(resolved.name, memoryScope, memoryRoot)
          } catch (e) {
            const message = `ERROR: subagent '${resolved.name}' not started: its memory could not be loaded (${e instanceof Error ? e.message : String(e)})`
            env.lane?.attach(callId, message)
            settleChild(true, message)
            return { output: message, isError: true }
          }
        }
        if (why || !loaded) {
          const message = `ERROR: subagent '${resolved.name}' not started: ${why}`
          env.lane?.attach(callId, message)
          settleChild(true, message)
          return { output: message, isError: true }
        }
        memoryBlockText = memoryBlock(memoryScope, loaded)
      }
      const memoryTools: Record<string, Tool> =
        memoryScope && memoryBlockText ? { [AGENT_MEMORY_TOOL_NAME]: agentMemoryTool } : {}
      const memoryHandled = (call: PendingToolCall, toolSignal: AbortSignal | undefined) =>
        call.toolName === AGENT_MEMORY_TOOL_NAME && memoryScope
          ? runMemoryWrite(call.input, {
              agent: resolved.name,
              scope: memoryScope,
              projectRoot: memoryRoot,
              deps: env.memoryDeps,
              approve: async (info) =>
                env.approveMemoryWrite
                  ? env.approveMemoryWrite({ ...info, signal: toolSignal ?? childAbort.signal })
                  : false,
            })
          : undefined
      const child = await runSubagent({
        resolved,
        spawn,
        maxConcurrent,
        // The definition's opening lines go before the parent's message. A
        // resumed child already has them in its history.
        description:
          resolved.initialPrompt && !remembered
            ? `${resolved.initialPrompt}

${req.description}`
            : req.description,
        ...(remembered ? { history: remembered.messages } : {}),
        // A fork: a copy of the parent's conversation and its own system prompt,
        // so nothing the child does reaches the parent's transcript.
        ...(forking && env.fork
          ? {
              history: structuredClone(env.fork.history()),
              systemOverride: env.fork.system(),
            }
          : {}),
        // The same identity the child's dispatched calls carry, for the calls
        // the runner refuses without dispatching.
        activity: setup.activity,
        model: forking
          ? model
          : (effortChoice && 'model' in effortChoice ? effortChoice.model : undefined) ?? choice.model ?? model,
        supportsVision: choice.supportsVision ?? env.supportsVision?.() ?? false,
        ...(!forking && choice.extraSystem.length + preloaded.blocks.length + (memoryBlockText ? 1 : 0) + (siblingBlock ? 1 : 0) > 0
          ? {
              extraSystem: [
                ...choice.extraSystem,
                ...preloaded.blocks,
                ...(memoryBlockText ? [memoryBlockText] : []),
                ...(siblingBlock ? [siblingBlock] : []),
              ],
            }
          : {}),
        providerOptions:
          !forking && effortChoice && 'model' in effortChoice
            ? effortChoice.providerOptions
            : env.providerOptions(),
        parentTools: env.parentTools(),
        system: setup.system,
        signal: childAbort.signal,
        sessionTokens: 0,
        ...(env.tokenLimit?.() !== undefined ? { tokenLimit: env.tokenLimit() } : {}),
        ...(env.maxSteps ? { maxSteps: env.maxSteps } : {}),
        // A background child may ask its parent; a foreground one cannot, the
        // parent being blocked in the call that started it.
        ...(askable || memoryScope
          ? {
              extraTools: {
                ...(askable ? { [ASK_PARENT_TOOL_NAME]: askParentTool } : {}),
                ...memoryTools,
              },
            }
          : {}),
        dispatch: askable || memoryScope
          ? async (call, toolSignal) => {
              const wrote = memoryHandled(call, toolSignal)
              if (wrote) return wrote
              if (!askable || call.toolName !== ASK_PARENT_TOOL_NAME) {
                return setup.dispatch(call, toolSignal)
              }
              const asked = await askParent({
                sessionId: env.sessionId,
                taskId: callId,
                agentName: resolved.name,
                question: (call.input as { question?: unknown } | null)?.question,
                signal: toolSignal ?? childAbort.signal,
              })
              return asked.status === 'answered'
                ? { output: renderAnswerForChild(asked.answer) }
                : { output: asked.message, isError: asked.status === 'refused' }
            }
          : setup.dispatch,
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
      // Remembered unless it was cut short by Stop, so the parent can send a
      // follow-up under the same id. A child inside a team has no caller to
      // tell, so it is not kept.
      const agentId = resumeId ?? callId
      const keep =
        !forking && !parentTaskId && !childAbort.signal.aborted && child.messages !== undefined
      if (keep && child.messages) {
        rememberSubagent(env.sessionId, agentId, {
          name: resolved.name,
          messages: child.messages,
        })
      }
      return {
        // Labelled as a subagent's report, with fence tags defanged: the parent
        // reads it as data with no user authority (coworkSubagentSafety.ts).
        output:
          labelSubagentOutput(resolved.name, child.output) +
          (keep ? resumeHint(agentId) : ''),
        isError: child.isError,
        ...(child.full ? { full: child.full } : {}),
      }
    } finally {
      env.signal.removeEventListener('abort', stopChild)
      teamSignal?.removeEventListener('abort', stopChild)
      roster.leave()
      unregisterSubagent(env.sessionId, childTaskId)
      // A throw from the dispatch would otherwise leave the record running with
      // nothing left to finish it.
      settleChild(true)
    }
  }
}
