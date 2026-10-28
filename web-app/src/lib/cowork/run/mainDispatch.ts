import { useCoworkActiveWork } from '@/hooks/useCoworkActiveWork'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { withToolTiming } from '@/hooks/useToolCallRuntime'
import { taskIdFor } from '@/lib/coworkActivity'
import type { ChildRunner } from '@/lib/coworkChildRunner'
import { dispatchCoworkTool, type DispatchContext } from '@/lib/coworkDispatch'
import { abortSubagent } from '@/lib/coworkRunner'
import { parseSubagentRequest } from '@/lib/coworkSubagent'
import type { SubagentDefinition } from '@/lib/coworkSubagentRegistry'
import type { CoworkChatTransport } from '@/lib/coworkTransport'
import type { RunState } from './runState'

type Authority = Parameters<
  ReturnType<typeof useCoworkActiveWork.getState>['acquire']
>[0]['authority']

/** What a main run's tool dispatcher reads, named rather than closed over. */
export type MainDispatchContext = Pick<
  DispatchContext,
  | 'readOnlyFolder'
  | 'extraFolders'
  | 'mode'
  | 'liveMode'
  | 'readFailures'
  | 'writeGrant'
  | 'access'
  | 'accessCapability'
  | 'editConsent'
  | 'worktreePath'
  | 'unresolvedSkills'
  | 'webSearch'
  | 'scopedInstructions'
  | 'tasks'
  | 'nudge'
  | 'onEnableTools'
  | 'onTodo'
  | 'onAsk'
  | 'onTeam'
  | 'onApproveMcp'
  | 'onNeedFolder'
  | 'onApprove'
  | 'onCampaign'
> & {
  rs: RunState
  sid: string
  runId: string
  modelId: string | undefined
  /** The session's folder when the run started. */
  folder: string | null | undefined
  transport: Pick<CoworkChatTransport, 'mcpServerFor'>
  /** The authority this run holds, handed to shells and children. */
  runAuthority: Authority
  agents: SubagentDefinition[]
  dispatchChild: ChildRunner
}

/** The `dispatch` a main run hands `runTurn`: one tool call, timed. */
export function createMainDispatch(ctx: MainDispatchContext) {
  const { rs, sid, runId } = ctx
  return (
    call: Parameters<typeof dispatchCoworkTool>[0],
    toolSignal: AbortSignal | undefined
  ) =>
    withToolTiming(call.toolCallId, () =>
      dispatchCoworkTool(call, {
        activity: {
          session: sid,
          run: runId,
          agent: 'main',
          invocation: rs.stepSnapshot?.invocation,
        },
        sessionId: sid,
        modelId: ctx.modelId,
        readOnlyFolder: ctx.readOnlyFolder,
        extraFolders: ctx.extraFolders,
        mode: ctx.mode,
        liveMode: ctx.liveMode,
        readFailures: ctx.readFailures,
        writeGrant: ctx.writeGrant,
        // The same frozen answers the first gate used, so the two cannot
        // disagree about what this run may change.
        access: ctx.access,
        accessCapability: ctx.accessCapability,
        editConsent: ctx.editConsent,
        worktreePath: ctx.worktreePath,
        // Snapshotted with the run: a skill the user asked for and did
        // not get stops changes. Inspection still proceeds.
        unresolvedSkills: ctx.unresolvedSkills,
        // The root this run is bound to, re-checked before every
        // filesystem call: detaching or switching folders mid-run must
        // not leave the run reading the folder that was taken away.
        bindingIntact: () =>
          (useCoworkSessions
            .getState()
            .sessions.find((one) => one.id === sid)?.folder ?? null) ===
          (ctx.folder ?? null),
        webSearch: ctx.webSearch,
        // The servers' tools this request advertised; a call to one goes
        // through the same prompt, with its server named so the user's
        // trust choices for that server apply.
        mcpServerFor: (name) => ctx.transport.mcpServerFor(name),
        onApproveMcp: ctx.onApproveMcp,
        onNeedFolder: ctx.onNeedFolder,
        onApprove: ctx.onApprove,
        onCampaign: ctx.onCampaign,
        // A shell handed to the backend outlives a cancelled run, so it
        // holds the authority it started with until the process is done.
        trackShell: () =>
          useCoworkActiveWork.getState().acquire({
            sessionId: sid,
            kind: 'shell',
            authority: ctx.runAuthority,
          }),
        // The child inherits this run's frozen authority and holds it
        // for as long as it runs. It cannot widen it: this is the only
        // authority handed down.
        trackSubagent: () =>
          useCoworkActiveWork.getState().acquire({
            sessionId: sid,
            kind: 'subagent',
            authority: ctx.runAuthority,
          }),
        scopedInstructions: ctx.scopedInstructions,
        tasks: ctx.tasks,
        cancelChild: (callId) =>
          abortSubagent(sid, taskIdFor(sid, runId, callId)),
        agentDefaults: (name) => ctx.agents.find((d) => d.name === name),
        onEnableTools: ctx.onEnableTools,
        onTodo: ctx.onTodo,
        onAsk: ctx.onAsk,
        nudge: ctx.nudge,
        onTask: async (callId, input) => {
          const req = parseSubagentRequest(input)
          if (typeof req === 'string') {
            return { output: `ERROR: ${req}`, isError: true }
          }
          return ctx.dispatchChild(callId, req)
        },
        onTeam: ctx.onTeam,
      }, toolSignal)
    )
}
