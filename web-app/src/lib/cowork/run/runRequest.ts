/* eslint-disable @typescript-eslint/no-explicit-any */
import { closeBrowserSession } from '@/lib/browserTool'
import { useBrowserVerify } from '@/hooks/useBrowserVerify'
import { parseSlashMarker, slashDisplay } from '@/lib/slashCommands'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'
import { toast } from 'sonner'
import { getLoadedModels } from '@janhq/tauri-plugin-llamacpp-api'
import { finishRunResources } from '@janhq/tauri-plugin-agent-tools-api'
import { useCoworkSessions, ensureCurrentSession } from '@/hooks/useCoworkSessions'
import { useSessionWorkspacePath } from '@/hooks/useSessionWorkspacePath'
import { resolveCoworkModel } from '@/lib/coworkModelChoice'
import {
  runTitle,
  type RunContext,
} from '@/lib/coworkActivityRecorder'
import type { CoworkTurn } from '@/types/coworkSession'
import {
  useMessageQueue,
  type QueuedMessageSender,
} from '@/stores/message-queue-store'
import { agentAttribution } from '@/lib/mailboxDelivery'
import { useModelProvider } from '@/hooks/useModelProvider'
import { refuseUnrunnable } from '@/lib/cowork/run/refuseUnrunnable'
import { assistantAnchorId } from '@/lib/coworkTurns'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'
import { useAssistant } from '@/hooks/useAssistant'
import {
  ContextOverflowError,
  isContextOverflow,
  planTurn,
  sessionTokenLimitFor,
} from '@/lib/coworkBudget'
import { restoreDeadline, startDeadline } from '@/lib/runDeadline'
import { accountedTotal } from '@/lib/coworkReadiness'
import { createStreamSink } from '@/lib/cowork/run/streamSink'
import { createLiveLane } from '@/lib/cowork/run/liveLane'
import { createStepHandlers } from '@/lib/cowork/run/stepHandlers'
import { createToolHandlers } from '@/lib/cowork/run/toolHandlers'
import { createTeamTool } from '@/lib/cowork/run/teamTool'
import { createApprovalHooks } from '@/lib/cowork/run/approvalHooks'
import { createMainDispatch } from '@/lib/cowork/run/mainDispatch'
import { useAppState } from '@/hooks/useAppState'
import { useCoworkOrigins } from '@/hooks/useCoworkOrigins'
import { useCoworkCheckpoints } from '@/hooks/useCoworkCheckpoints'
import type { Binding } from '@/lib/coworkReadiness'
import {
  acceptBaseline,
  baselineFromStatus,
  promptFolderAccess,
  unavailableBaseline,
  type GitBaseline,
  type RunOrigins,
} from '@/lib/coworkOrigins'
import { useCoworkActiveWork } from '@/hooks/useCoworkActiveWork'
import {
  isReadOnly,
  modeOf,
  type CoworkMode,
} from '@/lib/coworkMode'
import { isSpawnedSession } from '@/lib/spawnSession'
import { type PromptSnapshotRef } from '@/lib/providerFetch'
import { createDecodeClock } from '@/lib/tokenSpeed'
import { prepareCoworkAttachments, type CoworkAttachmentInput } from '@/lib/coworkAttachments'
import { type FileOrigin } from '@/lib/fileActivity'
import { loadGitStatus } from '@/lib/coworkGit'
import { configuredContextTokens } from '@/lib/coworkContextWindow'
import { useCoworkUserEdits } from '@/hooks/useCoworkUserEdits'
import { withUserEditNotice } from '@/lib/coworkCodeEdit'
import {
  expandCodeRefs,
  relativeToRoot,
  type CodeRef,
} from '@/lib/coworkCode'
import {
  extraFoldersOf,
  withMainFolderMark,
  writableExtraFoldersOf,
} from '@/lib/coworkFolders'
import { compactionWindow, resolveAutoCompact } from '@/lib/compaction'
import { modelSummarizer } from '@/lib/compactionSummarizer'
import {
  getCompactionPolicy,
  DEFAULT_COMPACTION_POLICY,
  type CompactionPolicy,
} from '@/lib/compactionPolicy'
import { isCoordinatorEligible } from '@/lib/campaignTools'
import { groupsToOffer } from '@/lib/coworkToolGroups'
import {
  createMailLedger,
} from '@/lib/mailAutoReply'
import { useCompatManifest } from '@/hooks/useCompatManifest'
import {
  compatInstructionBlocks,
  importedAgents,
  mergeSkillRegistry,
  nestedChainFor,
  manifestMatches as compatMatches,
  emptyManifest as emptyCompatManifest,
} from '@/lib/claudeCompat'
import { effectiveEnabled, useSkills } from '@/hooks/useSkills'
import {
  accessOf,
  effectiveAccess,
  runCarries,
} from '@/lib/coworkAccess'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import {
  parseSkillRequestTriggers,
  resolveSkills,
  unresolvedSkills,
  type ContextAccounting,
} from '@/lib/coworkReadiness'
import { notifyToolBatch, } from '@/lib/agentTools'
import {
  decideOpening,
  recordFor,
} from '@/lib/coworkContinuity'
import { CoworkChatTransport } from '@/lib/coworkTransport'
import { createCompactRun } from '@/lib/cowork/run/compactRun'
import { sendRemoteRequest } from '@/lib/cowork/run/remoteRequest'
import { settleRun } from '@/lib/cowork/run/settleRun'
import { createRunState } from '@/lib/cowork/run/runState'
import { childRunnerOptions } from '@/lib/cowork/run/childRunnerOptions'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { DEFAULT_SESSION_TITLE } from '@/lib/coworkSessionStart'
import { recordEvents } from '@/lib/eventLog'
import { getSandboxStatus, getSandboxToolchains } from '@/lib/agentTools'
import { coworkWebSearchScope, webSearchOnFor } from '@/hooks/useWebSearchChoice'
import { MAX_AGENT_STEPS } from '@/lib/coworkBudget'
import {
  beginRun,
  endRun,
  isAbortLike,
  runTurn,
  untilStopped,
} from '@/lib/coworkRunner'
import { useCoworkRun, type RunEnding } from '@/hooks/useCoworkRun'
import { isRemoteSession } from '@/lib/remoteCowork'
import { type SubagentDefinition } from '@/lib/coworkSubagentRegistry'
import {
  SUBAGENT_RESULT_HEAD_CHARS,
} from '@/lib/coworkSubagent'
import { BackgroundTasks } from '@/lib/coworkBackgroundTasks'
import { createChildRunner } from '@/lib/coworkChildRunner'
import { DelegationNudge } from '@/lib/delegationNudge'
import { errorText } from '@/lib/errorText'
import { loadProjectTooling, type LoadedTooling } from '@/lib/projectTooling'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { autoTitleCoworkSession } from '@/lib/coworkAutoTitle'
import { chooseWorkProfile } from '@/hooks/useWorkProfiles'
import { useJevSettings } from '@/hooks/useJevSettings'
import { workProfileAsker } from '@/lib/jev'
import { SMALL_WINDOW_TOKENS } from '@/lib/coworkTools'



import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

export type RunRequestArgs = [
  text: string | null,
  from?: QueuedMessageSender,
  hidden?: boolean,
  attachmentInput?: CoworkAttachmentInput,
  onRefused?: () => void,
]

/** What `runCoworkRequest` reads from the page, taken when a request starts. */
export type RunRequestEnv = {
  access: ReturnType<typeof accessOf>
  availableSkills: ReturnType<typeof useSkills>['skills']
  enabledSkills: ReturnType<typeof useSkills>['enabled']
  bindingRef: MutableRefObject<{ sessionId: string | null; folder: string | null }>
  capabilityState: ReturnType<typeof useDirectEditGrants.getState>['capability']
  compat: ReturnType<typeof useCompatManifest>['manifest']
  effective: ReturnType<typeof effectiveAccess>
  gitBranch: string | null
  globalProvider: ReturnType<typeof useModelProvider.getState>['selectedProvider']
  lastSnapshotRef: MutableRefObject<Record<string, PromptSnapshotRef>>
  liveGrant: ReturnType<typeof useDirectEditGrants.getState>['bySession'][string] | undefined
  modelCapabilities: ReturnType<typeof useModelCapabilities>
  originOfPath: (path: string) => FileOrigin
  paneSessionIdRef: MutableRefObject<string | undefined>
  pendingRefs: MutableRefObject<CodeRef[]>
  projectInstructions: string | null
  recordOrigins: Parameters<typeof settleRun>[0]['recordOrigins']
  restartAfterFolderRef: MutableRefObject<Record<string, true>>
  runRequestRef: MutableRefObject<(...args: RunRequestArgs) => Promise<void>>
  runSkillsRef: MutableRefObject<Record<string, ReturnType<typeof resolveSkills>>>
  serviceHub: ReturnType<typeof useServiceHub>
  sessionIdRef: MutableRefObject<string | null>
  setAdvertisedToolCount: Dispatch<SetStateAction<number | null>>
  setAdvertisedToolNames: Dispatch<SetStateAction<string[]>>
  setCompacting: Dispatch<SetStateAction<boolean>>
  setPendingFolder: Dispatch<SetStateAction<Record<string, string>>>
  setRunContext: Dispatch<SetStateAction<ContextAccounting | null>>
  subagentDefs: SubagentDefinition[]
  t: ReturnType<typeof useTranslation>['t']
  tooling: { folder: string; loaded: LoadedTooling | null } | null
  transportRef: MutableRefObject<CoworkChatTransport | null>
  workspacePath: ReturnType<typeof useSessionWorkspacePath>
  worktree: ReturnType<typeof useCoworkWorktrees.getState>['bySession'][string] | undefined
}

/** The session's mode as it is now, for a run that froze its own at the start. */
export function liveSessionMode(sid: string): CoworkMode | undefined {
  const session = useCoworkSessions.getState().sessions.find((x) => x.id === sid)
  return session ? modeOf(session) : undefined
}

/** The largest prompt the provider has already accepted in these turns. */
export const largestAcceptedPrompt = (
  turns: readonly { usage?: { prompt_tokens?: number } }[] | undefined
): number =>
  (turns ?? []).reduce(
    (max, turn) => Math.max(max, turn.usage?.prompt_tokens ?? 0),
    0
  )

/** A session title for a request: a `/command` is named as typed. */
export const slashTitle = (text: string) => {
  const slash = parseSlashMarker(text)
  return slash ? slashDisplay(slash.invocation) : text
}

/**
 * Drive one request. `text` is null for a resume — a retry after a failure
 * re-runs the committed history rather than re-sending the question, which
 * would leave the model reading it twice.
 */
export async function runCoworkRequest(
  env: RunRequestEnv,
  text: string | null,
  from?: QueuedMessageSender,
  // Flint's own request (the result card's Continue): sent to the model,
  // not drawn as something the user said.
  hidden = false,
  // Files attached to this message: documents staged in the composer, and
  // the media it passed along. Without this they were dropped on send.
  attachmentInput?: CoworkAttachmentInput,
  // Called when the request is refused before a run starts (no usable model,
  // a model that cannot call tools, a stale worktree), so the composer can
  // give the draft back instead of losing it.
  onRefused?: () => void
) {
  const {
    access,
    availableSkills,
    bindingRef,
    capabilityState,
    compat,
    effective,
    enabledSkills,
    gitBranch,
    globalProvider,
    lastSnapshotRef,
    liveGrant,
    modelCapabilities,
    originOfPath,
    paneSessionIdRef,
    pendingRefs,
    projectInstructions,
    recordOrigins,
    restartAfterFolderRef,
    runRequestRef,
    runSkillsRef,
    serviceHub,
    sessionIdRef,
    setAdvertisedToolCount,
    setAdvertisedToolNames,
    setCompacting,
    setPendingFolder,
    setRunContext,
    subagentDefs,
    t,
    tooling,
    transportRef,
    workspacePath,
    worktree,
  } = env
  const sid = ensureCurrentSession(paneSessionIdRef.current)
  // This session's run only: another session running is no reason to wait.
  if (useCoworkRun.getState().runs[sid]) return
  // A session the server runs is driven there: this page only sends the
  // message and mirrors the events (lib/remoteCowork.ts).
  if (isRemoteSession(sid)) {
    return sendRemoteRequest({ sid, text, attachmentInput, onRefused, t, serviceHub })
  }
  // The mail this run takes in (the message that woke it, and anything that
  // reaches it at a step boundary), so the run's final answer can go back to
  // the sender when the agent did not reply itself.
  const mailLedger = createMailLedger()
  mailLedger.note(from)
  // Read the attached files into the message. Documents go in as text (there
  // is no retrieval tool here to search them with), media as file parts.
  const attached =
    attachmentInput && (attachmentInput.docs.length > 0 || (attachmentInput.files?.length ?? 0) > 0)
      ? await prepareCoworkAttachments(attachmentInput, {
          sessionId: sid,
          serviceHub: serviceHub,
        })
      : null
  if (attached) {
    for (const f of attached.failed) {
      toast.error(t('common:coworkRun.readFailed', { name: f.name, error: f.error }))
    }
    if (attached.truncated.length > 0) {
      toast.info(t('common:coworkRun.partFits', { files: attached.truncated.join(', ') }))
    }
  }
  const store = useCoworkSessions.getState()
  const current = store.sessions.find((s) => s.id === sid)
  /**
   * The model this run is sent with: the session's own choice, or -- for a
   * session that has not made one -- the picker's, recorded on the session
   * so its next run uses the same one (janhq/jan#8905). Shadows the
   * picker's values for the rest of this function on purpose: nothing in a
   * run should read the global selection after this point.
   */
  // A saved model that no longer resolves falls back to the picker's and
  // the replacement is saved, so the session is repaired once.
  const resolved = resolveCoworkModel(
    current?.model,
    useModelProvider.getState()
  )
  const runChoice = resolved.choice
  const selectedProvider = runChoice?.provider ?? ''
  const selectedModel = resolved.model
  if (runChoice && resolved.save) store.setModel(sid, runChoice)
  /**
   * Skills asked for by *this* turn, frozen for the whole run.
   *
   * Resolved from the text actually submitted rather than from whatever is
   * in the composer when something happens to re-render: a follow-up like
   * "use the superpowers skill for this change" arrives on turn five, and
   * the composer is empty by the time the run reads it. A retake (`text` is
   * null) keeps the previous turn's answer rather than deciding that the
   * request was withdrawn because there is no new message to find it in.
   */
  // Flint's own skills and this folder's compatible ones, resolved as one
  // registry: a request names a skill, not a source, and a name claimed by
  // both lands as ambiguous rather than one silently winning.
  const runRegistry = mergeSkillRegistry(compat, {
    available: availableSkills.map((skill) => ({ name: skill.name })),
    enabled: new Set(
      effectiveEnabled(
        enabledSkills,
        availableSkills.map((skill) => skill.name)
      )
    ),
  })
  const skillNames = runRegistry.available.map((skill) => skill.name)
  const runSkills =
    text == null
      ? (runSkillsRef.current[sid] ?? [])
      : resolveSkills(parseSkillRequestTriggers(text, skillNames), runRegistry)
  runSkillsRef.current[sid] = runSkills
  if (!text && !(current?.messages?.length ?? 0)) return
  if (
    refuseUnrunnable({
      resolved,
      globalProvider,
      access,
      effective,
      t,
      onRefused,
    }) ||
    // Narrows the type; a missing model was refused just above.
    !selectedModel
  )
    return
  // Another session's message is not what this session is about.
  if (text && !from && !hidden && current?.title === DEFAULT_SESSION_TITLE) {
    // The prompt, cut short, until the model's own title arrives.
    const placeholder = slashTitle(text).slice(0, 40)
    store.setTitle(sid, placeholder)
    autoTitleCoworkSession(sid, slashTitle(text), placeholder)
  }
  // Work profiles (off unless the user turned them on): the new message
  // picks how the run approaches it -- Jev decides when its suggestions are
  // on, a keyword match otherwise, and a profile picked by hand is kept.
  if (text && !from && !hidden) {
    await chooseWorkProfile(
      sid,
      text,
      workProfileAsker(useJevSettings.getState().rerankMode)
    )
  }

  /**
   * A managed worktree still being the thing this session recorded.
   *
   * Checked before the run rather than trusted from the record, because
   * everything that invalidates one happens outside Flint: the directory
   * deleted, the branch moved by someone working in it, the repository
   * re-cloned at the same path. Writing into a stale binding is how a run
   * edits a checkout nobody thinks it is editing, so a worktree that is not
   * `ready` ends the session's authority and the run does not start. The
   * user is told which of those happened, because the right response differs
   * for each.
   */
  if (effective.destination === 'managed') {
    const health = await useCoworkWorktrees.getState().check(sid)
    if (health && health !== 'ready') {
      await useDirectEditGrants.getState().revokeSession(sid)
      useCoworkWorktrees.getState().forget(sid)
      useCoworkSessions.getState().setAccess(sid, 'review-only')
      toast.error(t(`common:coworkAccess.worktreeState.${health}`))
      onRefused?.()
      return
    }
  }

  // The guard at the top ran before the profile choice and the worktree check
  // awaited: a second send in that window passed it too. Only one may claim.
  if (useCoworkRun.getState().runs[sid]) return

  // Claimed before the first await (janhq/jan#8905): the run id, its
  // cancellation handle and the session's running state all exist from
  // here, so Stop reaches a run that is still preparing and a second request
  // in this session waits, while other sessions are untouched. Starting the
  // run also clears this session's last outcome, usage and subagent lanes.
  const runId = crypto.randomUUID()
  const controller = new AbortController()
  // Stopping the run ends its agent browser at once, not when a tool call it
  // was waiting on (a long `wait`, say) finally returns.
  controller.signal.addEventListener(
    'abort',
    () => void closeBrowserSession(sid),
    { once: true }
  )
  const handle = beginRun(sid, runId, controller)
  useCoworkRun.getState().startRun(sid, runId)
  useBrowserVerify.getState().clearReports(sid)
  // AH-005: the run's first canonical event, recorded where the run is
  // claimed so a run stopped during preparation still has a start and an
  // end. The title is the user's own words, so it is content: a
  // metadata-only export leaves it out.
  recordEvents([
    {
      id: `run:${runId}:started`,
      session: sid,
      run: runId,
      kind: 'run.started',
      payload: { model: selectedModel.id, title: runTitle(hidden ? null : text, current?.messages) ?? null },
    },
  ])
  const recordRunEnded = (ending: RunEnding | null) =>
    // AH-174: what the run's commands used, taken as it ends. A backend
    // that cannot say is an end without figures, never an end not recorded.
    void finishRunResources(runId)
      .catch(() => null)
      .then((resources) =>
        recordEvents([
          {
            id: `run:${runId}:ended`,
            session: sid,
            run: runId,
            kind: 'run.ended',
            payload: {
              stoppedBy: ending?.stoppedBy ?? 'unknown',
              detail: ending?.errorText ?? '',
              ...(resources ? { resources } : {}),
            },
          },
        ])
      )
  // This run's live lane. Every write names the run, so once the run is
  // stopped, replaced or its session deleted, a late write is refused
  // rather than drawn under whatever session is in view.
  const initialTurns: CoworkTurn[] = text
    ? [
        {
          role: 'user',
          content: attached ? `${text}${attached.shownNote}` : text,
          at: Date.now(),
          ...(attached && attached.keptImages.length > 0 ? { images: attached.keptImages } : {}),
          ...(from ? { from: agentAttribution(from) } : {}),
          ...(hidden ? { hidden: true } : {}),
        },
      ]
    : []
  const rs = createRunState(initialTurns)
  // The transcript row of this run's prompt (the id coworkTurnsToUIMessages
  // gives it), where a plan the run writes is recorded. A run without a
  // prompt of its own records it at the last one.
  const planAnchor = (() => {
    const base = current?.turns ?? []
    if (text) return `${sid}-user-${base.length}`
    for (let i = base.length - 1; i >= 0; i--) {
      if (base[i].role === 'user') return `${sid}-user-${i}`
    }
    return undefined
  })()
  const { saveInFlight, textFrame, publish, pushLive, mutateLive } = createLiveLane({
    rs,
    sid,
    runId,
    runStartedAt: Date.now(),
    runBaseCount: current?.messages?.length ?? 0,
    latestSnapshot: () => lastSnapshotRef.current[sid],
    projectRoot: () => runAuthority.folder ?? undefined,
  })
  publish()
  /**
   * The authority this run holds, taken once and kept for its lifetime.
   *
   * Registered before the first await: the model probe and the sandbox probe
   * below are both awaits, and the folder must not be swapped between
   * pressing send and the run actually starting.
   */
  const runAuthority = {
    folder: current?.folder ?? null,
    access: effective.access,
    destination: effective.destination,
  }
  const runWorkDone = useCoworkActiveWork.getState().acquire({
    sessionId: sid,
    kind: 'run',
    authority: runAuthority,
  })

  /**
   * Until the turn's own try/finally takes the run over (below), its
   * preparation owns it: Stop ends it here, and so does a probe that fails.
   * Neither did -- the session stayed running for as long as a probe took,
   * or for good once one threw. janhq/jan#8905.
   */
  const abandon = (ending: RunEnding) => {
    const othersRunning = Object.keys(useCoworkRun.getState().runs).some(
      (id) => id !== sid
    )
    if (!othersRunning) useAppState.getState().updateLoadingModel(false)
    endRun(sid, runId)
    void closeBrowserSession(sid)
    runWorkDone()
    for (const resolve of handle.pendingAsks.values()) resolve(null)
    handle.pendingAsks.clear()
    // What the user asked is kept, as it is when a turn stops later on.
    const prior = current?.messages ?? []
    useCoworkSessions.getState().commitTurns(
      sid,
      rs.runTurns,
      text
        ? [
            ...prior,
            {
              id: `${sid}-user-${prior.length}`,
              role: 'user',
              parts: [{ type: 'text', text }],
            } as any,
          ]
        : prior,
      useCoworkRun.getState().subagents[sid] ?? [],
      undefined
    )
    useCoworkRun.getState().finishRun(sid, runId, ending)
    recordRunEnded(ending)
    // Input typed for a run that never ran is held for the user, never
    // dropped and never sent on its own. janhq/jan#8864.
    useMessageQueue.getState().holdQueue(sid)
  }
  const STOPPED = Symbol('stopped')
  /** A preparation step, given up the moment Stop is pressed. */
  const prepared = async <T,>(work: Promise<T>): Promise<T | typeof STOPPED> => {
    try {
      return await untilStopped(work, controller.signal)
    } catch (e) {
      abandon(
        isAbortLike(e, controller.signal)
          ? { stoppedBy: 'aborted' }
          : { stoppedBy: 'error', errorText: errorText(e) }
      )
      return STOPPED
    }
  }

  // Local models load before the first token, but only on a cold start. Probe
  // the engine so the load card shows on a real load, not on every warm run.
  if (selectedProvider === 'llamacpp') {
    try {
      const loaded = await untilStopped(getLoadedModels(), controller.signal)
      if (!loaded.includes(selectedModel.id)) {
        useAppState.getState().updateModelLoadProgress(undefined)
        useAppState.getState().updateLoadingModel(true)
      }
    } catch {
      // Probe failed; skip the card rather than flash it every run.
    }
    if (controller.signal.aborted) return abandon({ stoppedBy: 'aborted' })
  }

  /**
   * What the working tree looked like before this run touched anything.
   *
   * Taken here, before the first tool call, because it is the only moment
   * that can answer "was this already different?" — and that question is
   * what stops the run's own report from handing the user their existing
   * uncommitted work back as something Flint did. Bound to the session and
   * folder it describes, and discarded outright if the user has moved on by
   * the time it arrives.
   */
  const baselineBinding: Binding = {
    sessionId: sid,
    folder: current?.folder ?? null,
  }
  /**
   * What this run reads and what authority it carries, decided once.
   *
   * Before the baseline, because the baseline has to be taken in the tree
   * the run will actually change: a managed session works in a worktree, and
   * a baseline of the attached folder would describe a tree nothing touched.
   */
  const carried = runCarries(effective, {
    folder: current?.folder ?? null,
    grantId: liveGrant?.grantId ?? null,
  })
  if (carried.readRoot) {
    let captured: GitBaseline
    try {
      captured = baselineFromStatus(
        await untilStopped(
          loadGitStatus(carried.readRoot, 'all'),
          controller.signal
        ),
        baselineBinding
      )
    } catch {
      // Git failing is not the same as a folder having no Git: with no
      // before-state, nothing found later can be dated at all.
      captured = unavailableBaseline(baselineBinding)
    }
    if (controller.signal.aborted) return abandon({ stoppedBy: 'aborted' })
    rs.runBaseline = acceptBaseline(captured, bindingRef.current)
  }

  /**
   * One snapshot, read by every surface that describes this run.
   *
   * Published before the prompt is built, because the prompt is the first
   * consumer: what the model is told about the folder has to come from the
   * same frozen answer the gate, readiness and the ledger use, or the run
   * describes itself wrongly from its first token.
   */
  const origins: RunOrigins = {
    binding: baselineBinding,
    access: effective.access,
    destination: runAuthority.destination,
    // The tree the changes land in, frozen with the rest: every surface that
    // reports what happened reads this one answer.
    tree: carried.readRoot,
    baseline: rs.runBaseline,
  }
  useCoworkOrigins.getState().begin(sid, origins)

  /**
   * A point this run can be taken back to.
   *
   * Only where Flint is about to change something: a review run writes
   * nothing, so there would be nothing to undo, and a checkpoint of the
   * user's checkout taken for a run that cannot touch it is a promise with
   * no work behind it.
   *
   * Whose tree it is is decided here, at capture, rather than at rewind
   * time by whoever is asking — which is what stops a rewind in the user's
   * own checkout from ever becoming a hard restore. A failure to take one is
   * not a reason to refuse the run the user asked for; it shows up as there
   * being no point to go back to.
   */
  if (carried.readRoot && effective.writeRoot) {
    void useCoworkCheckpoints.getState().capture({
      sessionId: sid,
      root: carried.readRoot,
      label: (text ?? '').trim().slice(0, 80) || 'run',
      changed: [],
      destination:
        origins.destination === 'managed' ? 'managed' : 'user-checkout',
      access: effective.access,
    })
  }

  /**
   * The compatibility manifest this run carries, frozen with everything
   * else.
   *
   * Discarded outright if it was resolved for a different binding: a scan of
   * the previous folder must not activate that folder's instructions against
   * this one. Configuration edited while the run is going applies to the
   * next run, not this one.
   */
  const runCompat = compatMatches(compat, baselineBinding)
    ? compat
    : emptyCompatManifest(baselineBinding)

  /**
   * The agents this run can dispatch: Flint's own, plus the repository's.
   *
   * Frozen with the manifest, so an agent file edited mid-run applies to the
   * next one. Flint's saved definitions win a name collision — a repository
   * must not be able to redefine an agent the user configured by choosing
   * its name — and the shadowed ones are named in the prompt rather than
   * silently dropped.
   */
  const imported = importedAgents(runCompat, subagentDefs)
  const runAgents = [...subagentDefs, ...imported.definitions]

  /**
   * Instructions a subtree owes this run, delivered once each.
   *
   * One tracker for the whole run, shared by the main agent and every
   * subagent: they are working in one repository under one manifest, and a
   * child that had to be told again — or worse, was never told — would be
   * following different rules from its parent in the same directory.
   */
  const deliveredScopes = new Set<string>()
  const scopedInstructionsFor = (path: string) => {
    const folder = current?.folder ?? null
    // Nested scopes are repository-relative; a tool may name either form.
    const relative = folder ? relativeToRoot(folder, path) : path
    const owed = nestedChainFor(runCompat, relative).filter(
      (one) => !deliveredScopes.has(one.scope)
    )
    for (const one of owed) deliveredScopes.add(one.scope)
    return owed
  }

  // Warm the sandbox probe: the transport's prompt and tool set read it
  // synchronously via sandboxEnforces().
  if ((await prepared(getSandboxStatus())) === STOPPED) return
  // Which runtimes the shell can start, so the model does not spend calls
  // finding out. Never throws; null (unknown) leaves the lines out.
  const toolchains = await prepared(getSandboxToolchains())
  if (toolchains === STOPPED) return
  // Read once per run, not subscribed: the advertised set is frozen for the
  // run anyway, so a mid-run flip in Settings would only desync the prompt.
  const webSearch = webSearchOnFor(
    current?.id ? coworkWebSearchScope(current.id) : null
  )
  // Read once, with the session this run is bound to: a mode flipped
  // mid-run would leave the advertised tools and the dispatcher disagreeing.
  const storedMode = modeOf(current ?? {})
  /**
   * How to treat this turn.
   *
   * Decided from what the user typed plus where the session already is, so a
   * plain instruction is followed and an opening remark is answered with a
   * proposal instead of an edit.
   */
  const opening = decideOpening({
    folder: current?.folder ?? null,
    priorTurns: current?.turns.length ?? 0,
    text: text ?? '',
    record: recordFor(current?.continuity ?? null, current?.folder ?? null),
    campaignTask: current?.campaign?.role === 'task',
  })
  // Bypass is the person's word that nothing needs protecting from a first
  // message, so an opening remark runs as typed instead of read-only.
  const inspecting = opening === 'inspect-and-propose' && storedMode !== 'bypass'
  /**
   * Review for an inspecting turn, whatever the session is set to.
   *
   * The classifier decides what to *ask* for; this is what makes the answer
   * unable to write. Both halves are needed: a classifier that misreads a
   * request must not be able to turn into an edit, which is the same doubling
   * plan mode uses when it both withholds a tool and refuses it by name.
   */
  const runMode = inspecting ? 'review' : storedMode
  /**
   * The write authority this run carries, frozen with everything else.
   *
   * Only sent when the effective access is actually direct editing — a
   * session whose stored preference says so but whose grant is missing,
   * revoked or issued elsewhere sends nothing and writes to its sandbox.
   * The id is authority-bearing and goes only to the backend command: never
   * into a prompt, a message, an activity row, or anything shown to anyone.
   */
  const runGrant = carried.writeGrant
  /**
   * The tree this run reads, frozen with everything else.
   *
   * From the effective access rather than the attached folder, because they
   * are not always the same tree: a managed worktree is the run's whole
   * world — read and written — and reading the source checkout alongside it
   * would let the agent reason about one tree while changing another.
   * Review and Ask read the attached folder and write nowhere, which is the
   * same value with no grant beside it.
   */
  const runReadRoot = carried.readRoot
  /**
   * Whether a team may give a task a checkout of its own, frozen with the
   * rest of the run.
   *
   * The same capability the access selector reads, so a refusal here says
   * what that screen already says rather than a second story about the same
   * platform.
   */
  const canIsolate =
    capabilityState.known && capabilityState.managedWorktree
  const canEditDirectly = capabilityState.known && capabilityState.directEdit
  /**
   * The session's extra attached folders, frozen with the run. Readable
   * always; writable only under the run's grant and where the platform can
   * confine a run to a user folder (the grant leaves them out otherwise).
   */
  const runExtraFolders = extraFoldersOf(current ?? { folder: null })
  // Per folder: the ones the user left editable, and only under the grant.
  const runWritableExtraFolders =
    runGrant && canEditDirectly
      ? writableExtraFoldersOf(current ?? { folder: null })
      : []
  /**
   * The second gate's inputs, frozen with the first.
   *
   * The dispatcher re-decides every mutation from the access mode, the
   * capability, the consent and the worktree — and it was being handed none
   * of them, so it decided every call as an unconfigured review-only session
   * and its own refusals could never fire. The write boundary itself is the
   * backend grant, so nothing escaped; what was missing was the second
   * opinion that exists to disagree when the first one is wrong.
   */
  const runCapability = {
    managedWorktree: canIsolate,
    directEdit: canEditDirectly,
  }
  const runConsent = liveGrant
    ? { sessionId: liveGrant.sessionId, folder: liveGrant.folder }
    : undefined
  const runWorktreePath = worktree?.path ?? null
  // The same facts the readiness card shows when the run reads the folder
  // on screen; read afresh for any other root (a managed worktree). Given up
  // on Stop like the rest of preparation, and never a reason not to run.
  if (runReadRoot) {
    const cached =
      tooling?.folder === runReadRoot ? tooling.loaded : null
    const loaded = cached ?? (await prepared(loadProjectTooling(runReadRoot)))
    if (loaded === STOPPED) return
    rs.runTooling = loaded.prompt
  }
  // A campaign coordinator or task on a window of 32K or less gets the
  // slim tool set: the full one alone would fill most of it.
  const campaignWindow = configuredContextTokens(modelCapabilities)
  const campaignSlim: 'coordinator' | 'task' | undefined =
    current?.campaign &&
    campaignWindow != null &&
    campaignWindow <= SMALL_WINDOW_TOKENS
      ? current.campaign.role === 'coordinator'
        ? 'coordinator'
        : 'task'
      : undefined
  const transport = new CoworkChatTransport(sid, {
    // Captured now: every step of this run uses it, whatever the picker
    // says by then (janhq/jan#8905).
    model: { provider: selectedProvider, id: selectedModel.id },
    planMode: isReadOnly(runMode),
    subagentNames: runAgents.map((d) => d.name),
    // Always on at depth 0, even with nothing saved: a one-off subagent with
    // an inline `system_prompt` is first-class, as it is in Rust.
    allowSubagents: !campaignSlim,
    spawned: !!current && isSpawnedSession(current),
    slim: campaignSlim,
    // Lean tool set: specialist groups this run's message, history or
    // sender call for; the rest wait behind `enable_tools`. A campaign's
    // slim set is already cut, so it keeps its own rules.
    offerGroups: campaignSlim
      ? undefined
      : groupsToOffer({
          text: text ?? '',
          history: current?.messages ?? [],
          fromSession: !!from,
        }),
    webSearch,
    // The campaign tools go to a top-level session that is not itself a
    // campaign task, and only when there is a repository to branch from.
    // Judged on the session's own mode, not the opening's forced review:
    // a read-only opening still sees `campaign_plan` (it asks first and
    // writes nothing to the checkout); a review-mode session does not.
    campaignCoordinator:
      isCoordinatorEligible(current?.campaign) &&
      !!current?.folder &&
      !isReadOnly(storedMode),
    // The session's own folder, which is what makes `stop_session` offerable
    // and what readiness is probed for. Not `runReadRoot`: a worktree run
    // reads somewhere else but is still this folder's session.
    projectRoot: current?.folder ?? undefined,
    workspacePath,
    readOnlyFolder: runReadRoot,
    extraFolders: runExtraFolders,
    writableExtraFolders: runWritableExtraFolders,
    // Read from the run's frozen snapshot, not re-derived here: the model
    // must be told exactly what the gate and the ledger will act on.
    folderAccess: withMainFolderMark(promptFolderAccess(origins), current),
    worktreeBranch: worktree?.branch ?? null,
    gitBranch,
    projectInstructions,
    // Only what the resolver made active: a file that is present but not
    // switched on, oversized, or pointing outside the folder contributes
    // nothing here.
    compatInstructions: compatInstructionBlocks(runCompat),
    projectTooling: rs.runTooling,
    openingInspection: inspecting,
    // What the shell can and cannot do, stated up front. Without it the
    // model learned by failing: probing the disk for runtimes, trying POSIX
    // syntax, and hunting for MCP servers by hand. The MCP line is stated by
    // the transport from the servers connected at each request.
    platform: IS_WINDOWS ? 'windows' : IS_MACOS ? 'macos' : 'linux',
    shellFlavor: IS_WINDOWS ? 'powershell' : 'posix',
    runnable: toolchains?.runnable,
    unavailable: toolchains?.unavailable,
    networkFromShell: useAgentToolsConfig.getState().bashNetworkEnabled,
  })
  transportRef.current = transport
  // Project memory is keyed by the attached folder's own identity file, not
  // by the tree this run reads: a managed worktree is the same project, and
  // a session with no folder has no project memory at all. Never temporary.
  transport.setMemoryBinding({
    projectRoot: current?.folder ?? undefined,
    temporary: false,
  })
  if ((await prepared(transport.refreshTools())) === STOPPED) return
  // Now the count is a fact rather than a guess, so the readiness card can
  // stop saying the tool set has not been built.
  const advertised = Object.keys(transport.advertisedTools)
  // Describes the session in view only: a background run must not rewrite
  // the readiness card of the session the user is looking at.
  if (sid === sessionIdRef.current) {
    setAdvertisedToolCount(advertised.length)
    setAdvertisedToolNames(advertised)
  }

  // Missing-path reads this run has seen, shared by the run and its
  // children and dropped with it (janhq/jan#8906).
  const runReadFailures = new Map<string, number>()
  /**
   * The snapshot of the request whose response the runner just read, taken
   * before that step's tool calls run. The session's latest snapshot is not
   * that once a call dispatches a subagent: the child sends requests through
   * the same model, under the same session. One request, one invocation id,
   * shared by its snapshot, its usage, its memory uses and the execution
   * events of the calls it asked for.
   */
  // Per-step generation timing, so a provider that reports no llama.cpp
  // `timings` (every remote model) still gets a tokens/sec figure -- the
  // provider's output tokens over the time any output (text, reasoning, tool
  // arguments) was arriving, the same measure the Chat transport uses.
  const decodeClock = createDecodeClock()
  const run: RunContext = {
    sessionId: sid,
    runId,
    // The turn's own question, or the one being taken again -- never an
    // instruction the app sent to continue an approved plan or retry what
    // the last run left open.
    title: runTitle(hidden ? null : text, current?.messages) || t('common:tasks.untitledRun'),
    model: selectedModel.id,
  }

  const { sink, streamed: streamedAssistantTurns, clearStreamedTurns } = createStreamSink({
    rs,
    run,
    decodeClock,
    scheduleFrame: () => textFrame.schedule(),
    publish,
    pushLive,
    saveInFlight,
    anchorMessageId: () => anchorMessageId(),
  })

  const baseMessages = current?.messages ?? []
  // The message this run's work is reported under, named by the same rule the
  // transcript conversion uses. Read at dispatch rather than guessed up
  // front: the block's id depends on which turn opened it, and only the
  // first dispatch's answer is kept, so the conversation shows exactly one
  // card per workflow.
  const anchorMessageId = () =>
    assistantAnchorId(
      [
        ...(useCoworkSessions.getState().sessions.find((s) => s.id === sid)
          ?.turns ?? []),
        ...rs.runTurns,
      ],
      sid
    )
  // The transcript shows `text` as typed; the model additionally receives the
  // staged code references expanded under it (exact path, line range and the
  // selected source). Only content the user explicitly selected travels.
  // And, when the user edited files by hand since the last turn, which ones,
  // so the agent re-reads them instead of editing from a stale copy.
  const modelText = text
    ? withUserEditNotice(
        expandCodeRefs(text, pendingRefs.current),
        useCoworkUserEdits.getState().takePending(sid)
      ) + (attached?.modelSuffix ?? '')
    : text
  pendingRefs.current = []
  /**
   * Run one child, and record it.
   *
   * Shared by `task` and `team` rather than written twice: a team's children
   * are this run's children, and they must inherit exactly the same frozen
   * authority, the same dispatcher, the same cancellation and the same
   * activity records. The recording, Stop and settling live in
   * `coworkChildRunner`, which plain chat and Rooms use too; what is below is
   * only what is particular to this run: where a child works, what it holds,
   * and how its calls are gated.
   */
  // One hint per run, for a survey the model reads itself.
  const delegationNudge = new DelegationNudge(() => true)
  const dispatchChild = createChildRunner({
    ...childRunnerOptions({
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
      get messages() {
        return messages
      },
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
      get dispatchChild() {
        return dispatchChild
      },
    }),
  })

  const messages = text
    ? [
        ...baseMessages,
        {
          id: `${sid}-user-${baseMessages.length}`,
          role: 'user',
          parts: [{ type: 'text', text: modelText }, ...(attached?.parts ?? [])],
        } as any,
      ]
    : [...baseMessages]

  // Measured here rather than at tool-refresh time because this is where the
  // payload exists: `messages` is what the request carries, and the transport
  // adds the system prompt and the advertised tools to it. Measuring earlier
  // would report a conversation one turn short of the one being sent.
  const runWindow = configuredContextTokens(
    modelCapabilities,
    largestAcceptedPrompt(current?.turns)
  )
  const measured = transport.measureContext(messages, runWindow)

  /**
   * Automatic compaction (`lib/compaction.ts`). On unless the model's Auto
   * Compact parameter is switched off, or the shared policy is. Before each
   * step the request is measured against the window the check below uses;
   * past the threshold, the older part of the run is summarized by the same
   * model and the run carries on.
   */
  let compactionPolicy: CompactionPolicy = DEFAULT_COMPACTION_POLICY
  try {
    compactionPolicy = await getCompactionPolicy(current?.folder ?? null)
  } catch (e) {
    console.warn('[cowork] compaction policy unreadable; using defaults', e)
  }
  const autoCompact = resolveAutoCompact(
    useAssistant.getState().currentAssistant?.parameters,
    compactionPolicy.auto
  )
  // A model with no configured window is unmeasurable until a server refuses a
  // request and names it; that number is used for the rest of this run, and
  // remembered so the next run plans against it from the start.
  const summarizeRun = modelSummarizer({
    provider: selectedProvider,
    modelId: selectedModel.id,
    session: sid,
    maxOutputTokens: compactionPolicy.summaryMaxTokens,
    window: () => runWindow ?? rs.learnedWindow,
    model: () => transport.model,
  })
  const compactRun = createCompactRun({
    sid,
    runId,
    autoCompact,
    runWindow,
    compactionPolicy,
    selectedProvider,
    selectedModelId: selectedModel.id,
    transport,
    summarize: summarizeRun,
    getLearnedWindow: () => rs.learnedWindow,
    setLearnedWindow: (tokens) => {
      rs.learnedWindow = tokens
    },
    setCompacting,
    pushLive: (turns) => pushLive(turns),
  })
  if (sid === sessionIdRef.current) setRunContext(measured)

  /**
   * Check the window before dispatching, not after the server complains.
   * AH-088.
   *
   * A request that fills the window leaves the model nowhere to answer, and
   * some providers respond to that by silently dropping the front of the
   * conversation -- so the run continues, having quietly forgotten what it
   * was asked. Refusing here keeps the failure visible and the transcript
   * intact. An unknown window is never a refusal: it is a limit Flint could
   * not discover, not a limit that was exceeded.
   */
  const accounted = accountedTotal(measured)
  const plan = planTurn({
    projected: accounted.tokens,
    window: measured.budget.known === false ? null : measured.budget.tokens,
  })
  // With compaction on, an overfull request is compacted before the first
  // step instead of refused.
  const overflow =
    plan.status === 'over' && accounted.complete && !autoCompact
      ? new ContextOverflowError(plan)
      : null

  // Recorded before the turn runs, so a crash mid-inspection is resumed as an
  // inspection rather than as work nobody authorised.
  if (current?.folder) {
    useCoworkSessions.getState().setContinuity(sid, {
      state: inspecting ? 'inspecting' : 'executing',
      folder: current.folder,
    })
  }

  /**
   * The run's wall-clock budget, persisted so a restart cannot reset it.
   * AH-018/AH-019.
   */
  const stored = current?.runBudget
  const resuming = stored?.runId === runId
  const runDeadline =
    (resuming
      ? restoreDeadline(
          { at: stored.deadlineAt, budgetMs: stored.deadlineBudgetMs },
          Date.now()
        )
      : null) ?? startDeadline(Date.now())
  useCoworkSessions.getState().setRunBudget(sid, {
    runId,
    steps: resuming ? stored.steps : 0,
    maxSteps: MAX_AGENT_STEPS,
    deadlineAt: runDeadline.at,
    deadlineBudgetMs: runDeadline.budgetMs,
  })

  /**
   * The instruction to continue with once this run ends, set when the
   * opening proposal is accepted (#296). The opening run is read-only by
   * construction and its tools are frozen, so the accepted step cannot run
   * here: it runs in a new request under the session's stored mode.
   */
  // The folder offer is made once per run, so a declined one is not repeated.
  // Subagents this run started with `task background:true`.
  const backgroundTasks = new BackgroundTasks(SUBAGENT_RESULT_HEAD_CHARS)
  try {
    // Raised here rather than returned earlier so the turn is torn down the
    // way every other ending is: the user's own message is committed, the
    // run is closed and nothing is left running.
    if (overflow) throw overflow
    const approvalHooks = createApprovalHooks({
      rs,
      sid,
      runId,
      folder: current?.folder,
      campaign: current?.campaign,
      storedMode,
      selectedProvider,
      modelId: selectedModel?.id,
      pickFolder: () => serviceHub.dialog().open({ directory: true }),
      holdFolder: (picked) => {
        restartAfterFolderRef.current[sid] = true
        setPendingFolder((pending) => ({ ...pending, [sid]: picked }))
      },
    })
    const teamTool = createTeamTool({
      sid,
      runId,
      run,
      signal: controller.signal,
      folder: current?.folder,
      modelId: selectedModel.id,
      canIsolate,
      dataFolder: () => serviceHub.app().getJanDataFolder(),
      anchorMessageId: () => anchorMessageId(),
      dispatchChild,
    })
    const toolHandlers = createToolHandlers({
      rs,
      sid,
      folder: current?.folder,
      access: effective.access,
      inspecting,
      planAnchor,
      handle,
      transport,
      mutateLive,
      t,
    })
    const mainDispatch = createMainDispatch({
      rs,
      sid,
      runId,
      modelId: selectedModel?.id,
      folder: current?.folder,
      readOnlyFolder: runReadRoot,
      extraFolders: runExtraFolders,
      mode: runMode,
      liveMode: () => liveSessionMode(sid),
      readFailures: runReadFailures,
      writeGrant: runGrant,
      access: effective.access,
      accessCapability: runCapability,
      editConsent: runConsent,
      worktreePath: runWorktreePath,
      unresolvedSkills: unresolvedSkills(runSkills),
      webSearch,
      transport,
      ...approvalHooks,
      runAuthority,
      scopedInstructions: scopedInstructionsFor,
      tasks: backgroundTasks,
      agents: runAgents,
      ...toolHandlers,
      nudge: delegationNudge,
      dispatchChild,
      onTeam: teamTool,
    })
    const stepHandlers = createStepHandlers({
      rs,
      sid,
      runId,
      run,
      modelId: selectedModel?.id,
      runDeadline,
      transport,
      decodeClock,
      streamed: streamedAssistantTurns,
      mailLedger,
      latestSnapshot: () => lastSnapshotRef.current[sid],
      originOfPath,
      saveInFlight,
      pushLive,
    })
    rs.outcome = await runTurn({
      messages,
      signal: controller.signal,
      /**
       * When this run must be over. AH-019.
       *
       * Restored rather than restarted when a run was already under way:
       * the wall clock kept running while the app was closed, and handing a
       * resumed run a fresh half hour would make the deadline mean nothing.
       */
      deadline: runDeadline,
      now: Date.now,
      // Starts at zero each request, matching Rust: `SessionBudget` is built
      // inside `run_orchestration_streamed`, so the allowance is per request.
      // The previous turn's `total_tokens` is a context size, not a spend, and
      // seeding with it would pre-charge the whole replayed prompt.
      sessionTokens: 0,
      // The allowance is a spend cap, not the window: with auto-compact on
      // it must not stop a run that is compacting its way through.
      sessionTokenLimit: sessionTokenLimitFor({
        autoCompact,
        window: compactionWindow(runWindow),
      }),
      deps: {
        // The session's `post-tool-batch` hooks, once a step's calls are all
        // answered; detached, so the run never waits for them.
        onBatchFinished: (names) =>
          notifyToolBatch(sid, names, 'session'),
        sendStep: (msgs, signal, stepOpts) => {
          // A retry starts a fresh stream; discard its predecessor's
          // unfinished optimistic rows before the new request.
          clearStreamedTurns()
          transport.textOnlyNext = stepOpts?.textOnly === true
          return transport.sendMessages({
            chatId: sid,
            messages: msgs,
            abortSignal: signal,
            trigger: 'submit-message',
            messageId: undefined,
          } as any)
        },
        dispatch: mainDispatch,
        sink,
        onStep: stepHandlers.onStep,
        onResponse: stepHandlers.onResponse,
        activity: stepHandlers.activity,
        compact: compactRun,
        nextMessageId: (() => {
          let n = baseMessages.length
          return () => `${sid}-asst-${n++}`
        })(),
        hasSteering: stepHandlers.hasSteering,
        takeSteering: stepHandlers.takeSteering,
      },
    })
    // Children the model started in the background and never collected:
    // wait for them rather than discard their work, as the Rust loop does.
    // Stop reaches them through their abort handles, so this cannot hang.
    await backgroundTasks.settleAll()
  } catch (e) {
    // The runner turns a failed step into an outcome, so this is the last
    // resort — a fault in the loop itself. Either way it is not a tool call,
    // and rendering it as one claimed the agent had run something.
    rs.thrown = isAbortLike(e, controller.signal)
      ? { stoppedBy: 'aborted' }
      : isContextOverflow(e)
        ? // Not an error in the loop: the request was measured, found not to
          // fit, and never sent. It offers the same way out as running out
          // of tokens mid-turn, because it is the same problem.
          { stoppedBy: 'tokens', errorText: e.message }
        : {
            stoppedBy: 'error',
            errorText: e instanceof Error ? e.message : String(e),
          }
  } finally {
    settleRun({
      sid,
      runId,
      handle,
      runTurns: rs.runTurns,
      messages,
      outcome: rs.outcome,
      thrown: rs.thrown,
      origins,
      originOfPath,
      recordOrigins,
      runWorkDone,
      recordRunEnded,
      mailLedger,
      continueWith: rs.continueWith,
      runAgain: (next) => runRequestRef.current(next),
    })
  }
}
