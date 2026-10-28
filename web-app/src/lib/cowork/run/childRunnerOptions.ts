import type { UIMessage } from 'ai'
import type { ToolchainReport } from '@janhq/tauri-plugin-agent-tools-api'
import { capMode, isReadOnly, type CoworkMode } from '@/lib/coworkMode'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { AGENT_MEMORY_TOOL_NAME } from '@/lib/coworkSubagentMemory'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { subagentActorId, parseSubagentRequest } from '@/lib/coworkSubagent'
import { sandboxEnforces } from '@/lib/agentTools'
import { promptFolderAccess, type RunOrigins } from '@/lib/coworkOrigins'
import { withMainFolderMark } from '@/lib/coworkFolders'
import { compatInstructionBlocks, type ImportedAgentDefinition, type CompatibilityManifest, type ScopedInstruction } from '@/lib/claudeCompat'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { dispatchCoworkTool } from '@/lib/coworkDispatch'
import { unresolvedSkills, type ResolvedSkill, type WriteDestination } from '@/lib/coworkReadiness'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import { useCoworkActiveWork } from '@/hooks/useCoworkActiveWork'
import type { RunContext } from '@/lib/coworkActivityRecorder'
import type { CoworkChatTransport } from '@/lib/coworkTransport'
import type { WorktreeRecord } from '@/hooks/useCoworkWorktrees'
import type { AccessMode, EffectiveAccess } from '@/lib/coworkAccess'
import type { ChildRunner, ChildRunnerEnv } from '@/lib/coworkChildRunner'

export type ChildRunnerOptionsContext = {
  sid: string
  runId: `${string}-${string}-${string}-${string}-${string}`
  run: RunContext
  selectedModel: Model
  selectedProvider: string
  transport: CoworkChatTransport
  runAgents: ImportedAgentDefinition[]
  controller: AbortController
  liveSessionMode: (sid: string) => CoworkMode | undefined
  runMode: CoworkMode
  messages: UIMessage[]
  anchorMessageId: () => string | undefined
  runReadRoot: string | null
  runGrant: string | null
  runExtraFolders: string[]
  workspacePath: string | null
  runWritableExtraFolders: string[]
  origins: RunOrigins
  current: CoworkSession | undefined
  worktree: WorktreeRecord | undefined
  projectInstructions: string | null
  runCompat: CompatibilityManifest
  toolchains: ToolchainReport | null
  runReadFailures: Map<string, number>
  effective: EffectiveAccess
  runCapability: { managedWorktree: boolean; directEdit: boolean; }
  runConsent: { sessionId: string; folder: string; } | undefined
  runWorktreePath: string | null
  runSkills: ResolvedSkill[]
  webSearch: boolean
  runAuthority: { folder: string | null; access: AccessMode; destination: WriteDestination; }
  scopedInstructionsFor: (path: string) => ScopedInstruction[]
  dispatchChild: ChildRunner
}

export function childRunnerOptions(ctx: ChildRunnerOptionsContext): ChildRunnerEnv {
  const {
    sid,
    runId,
    run,
    selectedModel,
    selectedProvider,
    transport,
    runAgents,
    controller,
    liveSessionMode,
    runMode,
    anchorMessageId,
    runReadRoot,
    runGrant,
    runExtraFolders,
    workspacePath,
    runWritableExtraFolders,
    origins,
    current,
    worktree,
    projectInstructions,
    runCompat,
    toolchains,
    runReadFailures,
    effective,
    runCapability,
    runConsent,
    runWorktreePath,
    runSkills,
    webSearch,
    runAuthority,
    scopedInstructionsFor,
  } = ctx
  return {
    sessionId: sid,
    runId,
    run,
    modelId: selectedModel.id,
    providerId: selectedProvider,
    parent: () => transport.persona(),
    definitions: runAgents,
    signal: controller.signal,
    // The parent's instance: a second one would mean a second llama-server
    // load for the same model.
    model: () => transport.model,
    supportsVision: () =>
      selectedModel?.capabilities?.includes('vision') ?? false,
    providerOptions: () => transport.reasoningProviderOptions(),
    // A subagent's own memory is the user's to approve, write by write. Review
    // and plan modes change nothing, so a write is refused there without asking.
    launchGate: {
      mode: (resolved) => {
        const live = liveSessionMode(sid) ?? runMode
        return capMode(live, resolved.permissionMode)
      },
      ask: ({ agent, tools, model, signal }) =>
        useToolApprovalRequests
          .getState()
          .requestApproval(`agent-launch:${agent}:${Date.now()}`, 'task', sid, undefined, {
            input: { agent, tools, model },
            alwaysAsk: true,
            taskContext: `Run subagent "${agent}" with ${tools.join(', ')} on ${model}? It will ask before each change as usual; this is asked once for this session.`,
            origin: agent,
            signal,
          }),
    },
    // A forked subagent starts from the conversation this turn began with.
    fork: {
      history: () => ctx.messages,
      system: () => transport.forkSystemPrompt(ctx.messages),
    },
    approveMemoryWrite: async ({ agent, scope, content, signal }) => {
      const live = liveSessionMode(sid) ?? runMode
      if (isReadOnly(live)) return false
      return useToolApprovalRequests
        .getState()
        .requestApproval(`agent-memory:${agent}:${Date.now()}`, AGENT_MEMORY_TOOL_NAME, sid, undefined, {
          input: { agent, scope, content },
          alwaysAsk: true,
          taskContext: `${agent} wants to replace its ${scope} memory (MEMORY.md)`,
          preview: content,
          origin: agent,
          signal,
        })
    },
    parentTools: () => transport.childToolSet,
    anchorMessageId,
    lane: {
      queue: (callId, name, waiting) =>
        useCoworkRun.getState().queueSubagent(sid, callId, name, waiting),
      start: (callId, name) =>
        useCoworkRun.getState().startSubagent(sid, callId, name),
      inner: (callId, event) =>
        useCoworkRun.getState().routeIntoSubagent(sid, callId, event),
      turns: (callId) =>
        (useCoworkRun.getState().subagents[sid] ?? []).find(
          (one) => one.runId === callId
        )?.turns,
      end: (callId, usage) =>
        useCoworkRun.getState().endSubagent(sid, callId, usage),
      attach: (callId, output) =>
        useCoworkRun.getState().attachSubagentOutput(sid, callId, output),
    },
    setup: (resolved, destination, spawn) => {
      const childFolder = destination?.path ?? runReadRoot
      const childGrant = destination ? destination.grantId : runGrant
      // A child in the run's own tree shares its extra folders; one given an
      // isolated checkout holds a grant for that checkout alone.
      const childExtras = destination ? [] : runExtraFolders
      const childOwner = destination?.ownerId ?? sid
      const identity = {
        session: sid,
        run: runId,
        agent: resolved.name,
        // AH-110: what a change it makes is attributed to. A role Flint
        // ships is a role; anything else is an agent by that name.
        agentId: subagentActorId(resolved),
        parentAgent: 'agent',
        project: workspacePath ?? '',
      }
      return {
        activity: () => identity,
        system: {
          workspacePath,
          readOnlyFolder: childFolder,
          extraFolders: childExtras,
          writableExtraFolders: destination ? [] : runWritableExtraFolders,
          bashAvailable: sandboxEnforces(),
          // The parent's frozen answers, handed down unchanged: a child never
          // resolves its own access or its own instructions.
          folderAccess: destination
            ? promptFolderAccess(origins)
            : withMainFolderMark(promptFolderAccess(origins), current),
          worktreeBranch: worktree?.branch ?? null,
          projectInstructions,
          compatInstructions: compatInstructionBlocks(runCompat),
          platform: IS_WINDOWS ? 'windows' : IS_MACOS ? 'macos' : 'linux',
          shellFlavor: IS_WINDOWS ? 'powershell' : 'posix',
          runnable: toolchains?.runnable,
          unavailable: toolchains?.unavailable,
          networkFromShell: useAgentToolsConfig.getState().bashNetworkEnabled,
          mcpServers: [],
        },
        // A child never gets `todo`/`ask`/`task`, so these refuse rather than
        // execute: a model can still emit a call to a tool that was never
        // advertised.
        dispatch: (call, toolSignal) =>
        dispatchCoworkTool(call, {
          // Recorded under the parent's run and this child's own name, so
          // the timeline shows which agent did a thing without splitting
          // the run it belongs to.
          activity: {
            session: sid,
            run: runId,
            agent: resolved.name,
            agentId: subagentActorId(resolved),
            parentAgent: 'agent',
            project: workspacePath ?? '',
          },
          // The owner the grant was issued to, not the run's session: an
          // isolated child's authority is its own, and the backend refuses a
          // grant presented under any other id.
          sessionId: childOwner,
          // The parent's model: a child runs on the same instance.
          modelId: selectedModel?.id,
          readOnlyFolder: childFolder,
          extraFolders: childExtras,
          // The definition may ask for a stricter mode, never a looser one: the
          // run's mode, live or frozen, is the ceiling.
          mode: capMode(runMode, resolved.permissionMode),
          liveMode: () => {
            const live = liveSessionMode(sid)
            return live ? capMode(live, resolved.permissionMode) : undefined
          },
          readFailures: runReadFailures,
          writeGrant: childGrant,
          // A child in its own checkout is a managed-worktree run of its
          // own, consented to under its own owner id. Inheriting the
          // parent's answers here would have the gate check a tree the
          // child is not in.
          access: destination ? 'managed-worktree' : effective.access,
          accessCapability: runCapability,
          editConsent: destination
            ? { sessionId: destination.ownerId, folder: destination.path }
            : runConsent,
          worktreePath: destination ? destination.path : runWorktreePath,
          // Snapshotted with the run: a skill the user asked for and did
          // not get stops changes. Inspection still proceeds.
          unresolvedSkills: unresolvedSkills(runSkills),
          // The root this run is bound to, re-checked before every
          // filesystem call: detaching or switching folders mid-run must
          // not leave the run reading the folder that was taken away.
          bindingIntact: () =>
            (useCoworkSessions
              .getState()
              .sessions.find((one) => one.id === sid)?.folder ?? null) ===
            (current?.folder ?? null),
          webSearch,
          // A subagent's mutations are the session's mutations, so
          // they go through the same prompt rather than around it --
          // shown on its own, because the child's calls are not parts of
          // any message on screen.
          onApprove: (callId, toolName, input, preview, signal, forced) =>
            useToolApprovalRequests
              .getState()
              .requestApproval(callId, toolName, sid, undefined, {
                input,
                ...(forced
                  ? {
                      alwaysAsk: true,
                      taskContext: forced.reason,
                      conversationProgram: forced.conversationProgram,
                      onDecision: forced.onDecision,
                    }
                  : {}),
                workspaceLabel:
                  (destination ? destination.path : current?.folder) ??
                  undefined,
                preview,
                origin: destination
                  ? `${resolved.name} (its own checkout)`
                  : resolved.name,
                signal,
              }),
          trackShell: () =>
            useCoworkActiveWork.getState().acquire({
              sessionId: sid,
              kind: 'shell',
              authority: runAuthority,
            }),
          // The same resolver and the same tracker the parent
          // uses: one repository, one manifest, one set of rules.
          scopedInstructions: scopedInstructionsFor,
          onTodo: async () => ({
            output:
              'The todo list belongs to the agent that dispatched you.',
            isError: true,
          }),
          onAsk: async () => ({
            output:
              'You cannot ask the user questions. Decide, and say what you assumed.',
            isError: true,
          }),
          // Nesting is off unless Settings > Subagents raises the depth: then a
          // child below the limit runs its `task` as a child one level down,
          // under the same caps. At the limit it is refused as before.
          onTask: async (nestedCallId, input) => {
            if (!spawn || spawn.depth >= spawn.maxDepth) {
              return { output: 'A subagent cannot dispatch subagents.', isError: true }
            }
            const nested = parseSubagentRequest(input)
            if (typeof nested === 'string') {
              return { output: `ERROR: ${nested}`, isError: true }
            }
            if (nested.fork) {
              return { output: 'A subagent cannot fork.', isError: true }
            }
            return ctx.dispatchChild(
              nestedCallId,
              nested,
              undefined,
              undefined,
              undefined,
              undefined,
              spawn.depth
            )
          },
        }, toolSignal),
      }
    },
  }
}
