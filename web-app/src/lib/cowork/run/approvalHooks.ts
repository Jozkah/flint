import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { createToolDeps, getCampaignRunner } from '@/lib/campaignHost'
import { executeCampaignTool, isCoordinatorEligible } from '@/lib/campaignTools'
import type { DispatchContext } from '@/lib/coworkDispatch'
import type { RunState } from './runState'

/** What a main run's approval hooks read, named rather than closed over. */
export type ApprovalHooksContext = {
  rs: RunState
  sid: string
  runId: string
  /** The session's folder when the run started. */
  folder: string | null | undefined
  campaign: Parameters<typeof isCoordinatorEligible>[0]
  /** The session's own mode (not an opening turn's forced review). */
  storedMode: Parameters<typeof executeCampaignTool>[1]['mode']
  selectedProvider: string
  modelId: string | undefined
  /** Asks the user for a folder; a string is the folder picked. */
  pickFolder: () => Promise<unknown>
  /** Holds the picked folder; the run restarts once it is applied. */
  holdFolder: (picked: string) => void
}

/**
 * The dispatcher's approval prompts for a main run: MCP calls, a missing
 * folder, ordinary tool approval and -- on a session that may coordinate --
 * the campaign tools.
 */
export function createApprovalHooks(ctx: ApprovalHooksContext): Pick<
  DispatchContext,
  'onApproveMcp' | 'onNeedFolder' | 'onApprove' | 'onCampaign'
> {
  const { rs, sid, runId } = ctx
  return {
    onApproveMcp: (callId, toolName, input, server, signal) =>
      useToolApprovalRequests
        .getState()
        .requestApproval(callId, toolName, sid, server, {
          input,
          workspaceLabel: ctx.folder ?? undefined,
          autoApproveStreak: sid,
          signal,
        }),
    // A refusal for a path outside the sandbox, with no folder
    // attached: ask once per run whether to attach one. A run's
    // folder is fixed once it starts, so on yes the pick is held
    // and the run ends; it restarts when the folder is applied.
    onNeedFolder: async ({ signal }) => {
      if (rs.folderOffered) return 'declined'
      rs.folderOffered = true
      const ok = await useToolApprovalRequests
        .getState()
        .requestApproval(
          `${runId}:attach-folder`,
          'attach_folder',
          sid,
          undefined,
          {
            input: {},
            alwaysAsk: true,
            taskContext:
              'This run needs files outside its sandbox, but no project folder is attached. Attach one so the run can continue?',
            signal,
          }
        )
      if (!ok) return 'declined'
      const picked = await ctx.pickFolder()
      if (typeof picked !== 'string') return 'declined'
      ctx.holdFolder(picked)
      return 'attached'
    },
    // The prompt the chat surface already uses for tool approval,
    // not a second one: it honours grants the user has already made
    // and renders in the tool card the call is reported in.
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
          workspaceLabel: ctx.folder ?? undefined,
          preview,
          signal,
        }),
    // Campaign tools exist only here, on the main run of a session
    // that may coordinate: a task's, a subagent's and chat's
    // contexts have no handler, so a call to one is refused.
    onCampaign:
      isCoordinatorEligible(ctx.campaign) && ctx.folder
        ? (call, campaignSignal) =>
            executeCampaignTool(
              call,
              {
                sessionId: sid,
                // The session's own mode: an opening turn's
                // forced review must not cap the tasks at review.
                mode: ctx.storedMode,
                sourceRoot: ctx.folder ?? null,
                model: ctx.modelId
                  ? {
                      provider: ctx.selectedProvider,
                      id: ctx.modelId,
                    }
                  : undefined,
                signal: campaignSignal,
                onApprove: (
                  callId,
                  toolName,
                  input,
                  _preview,
                  approveSignal,
                  forced
                ) =>
                  useToolApprovalRequests
                    .getState()
                    .requestApproval(
                      callId,
                      toolName,
                      sid,
                      undefined,
                      {
                        input,
                        alwaysAsk: true,
                        taskContext: forced?.reason,
                        workspaceLabel: ctx.folder ?? undefined,
                        signal: approveSignal,
                        // The plan card's "how should tasks work".
                        choice: forced?.choice,
                        onDecision: (decision, chosenId) => {
                          if (decision !== 'deny' && chosenId) {
                            forced?.onChoice?.(chosenId)
                          }
                        },
                      }
                    ),
              },
              createToolDeps(getCampaignRunner())
            )
        : undefined,
  }
}
