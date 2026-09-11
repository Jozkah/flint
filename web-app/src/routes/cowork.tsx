/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from '@tanstack/react-router'
import ChatInput from '@/containers/ChatInput'
import { CodeOpenProvider } from '@/containers/message/CodeOpenProvider'
import HeaderPage from '@/containers/HeaderPage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { route } from '@/constants/routes'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'
import { invoke } from '@tauri-apps/api/core'
import { getLoadedModels } from '@janhq/tauri-plugin-llamacpp-api'
import {
  bashJobsList,
  projectListDir,
  projectReadFile,
} from '@janhq/tauri-plugin-agent-tools-api'
import { cn } from '@/lib/utils'
import {
  useCoworkSessions,
  ensureCurrentSession,
} from '@/hooks/useCoworkSessions'
import { useSessionWorkspacePath } from '@/hooks/useSessionWorkspacePath'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import {
  lastUserQuestion,
  recordAgentDispatch,
  recordJobCollected,
  recordShellDispatch,
  recordShellOutcome,
  type RunContext,
} from '@/lib/coworkActivityRecorder'
import { collectedJobId, commandOf, countToolCalls } from '@/lib/coworkTasks'
import {
  INTERRUPTED_BY_RUN_END,
  findTaskByJob,
  sessionTotals,
  sessionWorkflows,
  taskIdFor,
  workflowAnchoredAt,
  type ActivityTask,
  type WorkflowView,
} from '@/lib/coworkActivity'
import {
  CANCELLED_BY_USER,
  cancelMessage,
  cancelTask as cancelTaskRequest,
  cancelWorkflow as cancelWorkflowRequest,
  patchForOutcome,
} from '@/lib/coworkCancel'
import { CoworkWorkflowCard } from '@/containers/CoworkWorkflowCard'
import type { AskAnswer, CoworkTurn, Usage } from '@/types/coworkSession'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import { PageHeaderRow } from '@/containers/PageHeaderRow'
import { useModelProvider } from '@/hooks/useModelProvider'
import { MessageItem } from '@/containers/MessageItem'
import SkillSelector from '@/containers/SkillSelector'
import { assistantAnchorId, coworkTurnsToUIMessages } from '@/lib/coworkTurns'
import { reconcileToolActivity } from '@/lib/coworkActivityTimeline'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'
import {
  ContextOverflowError,
  isContextOverflow,
  planTurn,
} from '@/lib/coworkBudget'
import { restoreDeadline, startDeadline } from '@/lib/runDeadline'
import { accountedTotal } from '@/lib/coworkReadiness'
import {
  formatChangeSummary,
  janAuthoredChanges,
} from '@/lib/coworkChangeSummary'
import { loadToolActivity, type ToolActivityItem } from '@/lib/toolActivity'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { PromptProgress } from '@/components/PromptProgress'
import { useAppState } from '@/hooks/useAppState'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { CoworkWorkspacePill } from '@/containers/CoworkWorkspacePill'
import { CoworkModeSelector } from '@/containers/CoworkModeSelector'
import { CoworkAccessSelector } from '@/containers/CoworkAccessSelector'
import { authorizeDirectEdit as runAuthorizeDirectEdit } from '@/lib/coworkDirectEdit'
import { useCoworkOrigins } from '@/hooks/useCoworkOrigins'
import { useCoworkCheckpoints } from '@/hooks/useCoworkCheckpoints'
import type { Binding } from '@/lib/coworkReadiness'
import {
  acceptBaseline,
  baselineFromStatus,
  buildOriginLedger,
  destinationOfOrigin,
  evidenceLimit,
  promptFolderAccess,
  summarizeRun,
  unavailableBaseline,
  type GitBaseline,
  type JanFileCall,
  type RunOrigins,
} from '@/lib/coworkOrigins'
import {
  authorityMayChange,
  useCoworkActiveWork,
  type WorkKind,
} from '@/hooks/useCoworkActiveWork'
import {
  DirectEditConfirmDialog,
  type DirectEditFacts,
} from '@/containers/dialogs/DirectEditConfirmDialog'
import { isReadOnly, modeOf } from '@/lib/coworkMode'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { CoworkEmptyState } from '@/containers/CoworkEmptyState'
import { CoworkHiddenTools } from '@/containers/CoworkHiddenTools'
import { useCoworkDisplay } from '@/hooks/useCoworkDisplay'
import type { AskRecord } from '@/types/coworkSession'
import { CoworkSessionDetails } from '@/containers/CoworkSessionDetails'
import { CoworkEnvironmentReadiness } from '@/containers/CoworkEnvironmentReadiness'
import { usePrompt } from '@/hooks/usePrompt'
import { setSnapshotSink, type PromptSnapshotRef } from '@/lib/providerFetch'
import { recordPayloadUsage } from '@/lib/payloadUsage'
import { attachAskToTurns, settleAskInTurns } from '@/hooks/useCoworkRun'
import {
  NO_SESSION,
  useCoworkView,
  type CoworkRail,
} from '@/hooks/useCoworkView'
import { useFileActivity } from '@/hooks/useFileActivity'
import {
  deriveFromSubagent,
  deriveFromTurns,
  isChange,
  type FileActivityEvent,
  type FileOrigin,
} from '@/lib/fileActivity'
import { loadGitStatus } from '@/lib/coworkGit'
import { awaitsModel } from '@/lib/agentActivity'
import { artifactsFromParts } from '@/lib/coworkArtifacts'
import { CoworkArtifactCard } from '@/containers/CoworkArtifactCard'
import { CoworkPreviewPanel } from '@/containers/CoworkPreviewPanel'
import { CoworkDiffPanel } from '@/containers/CoworkDiffPanel'
import { CoworkRewind } from '@/containers/CoworkRewind'
import { CoworkCodePanel } from '@/containers/CoworkCodePanel'
import { CoworkTasksPanel } from '@/containers/CoworkTasksPanel'
import type { LiveJob } from '@/lib/coworkTasks'
import {
  codeRefToken,
  emptyCodePanelState,
  expandCodeRefs,
  artifactTab,
  openTab,
  projectKeyOf,
  projectTab,
  sandboxTab,
  shouldOpenInCode,
  relativeToRoot,
  type CodeRef,
  type CodeTab,
} from '@/lib/coworkCode'
import {
  CoworkRailToolbar,
  type RailMode,
} from '@/containers/CoworkRailToolbar'
import { useCoworkGitStatus } from '@/hooks/useCoworkGitStatus'
import { collectCodeFileDiffs } from '@/lib/coworkDiffs'
import { CoworkSandboxChip } from '@/containers/CoworkSandboxChip'
import { CoworkBudgetNotice } from '@/containers/CoworkBudgetNotice'
import { CoworkRunSummary } from '@/containers/CoworkRunSummary'
import { hasJanAuthoredChanges } from '@/lib/coworkOrigins'
import { CoworkRunNotice } from '@/containers/CoworkRunNotice'
import { CoworkAskEntry } from '@/containers/CoworkAskEntry'
import { CoworkContextBreakdown } from '@/containers/CoworkContextBreakdown'
import { CoworkReadinessCard } from '@/containers/CoworkReadinessCard'
import { CoworkProjectInit } from '@/containers/CoworkProjectInit'
import { CoworkHandoffNotice } from '@/containers/CoworkHandoffNotice'
import { CoworkWorktreeRecovery } from '@/containers/CoworkWorktreeRecovery'
import { orphans as orphanWorktrees } from '@/lib/coworkWorktrees'
import { CoworkCompatSection } from '@/containers/CoworkCompatSection'
import { ClaudeSkillRootsSettings } from '@/containers/ClaudeSkillRootsSettings'
import { useClaudeCompat } from '@/hooks/useClaudeCompat'
import { useCompatManifest } from '@/hooks/useCompatManifest'
import { useImportedMcp } from '@/hooks/useImportedMcp'
import {
  compatInstructionBlocks,
  importedAgents,
  mergeSkillRegistry,
  nestedChainFor,
  manifestMatches as compatMatches,
  emptyManifest as emptyCompatManifest,
} from '@/lib/claudeCompat'
import { effectiveEnabled, useSkills } from '@/hooks/useSkills'
import { accessOf, effectiveAccess, runCarries } from '@/lib/coworkAccess'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import {
  COMPATIBILITY_INSTRUCTION_FILES,
  MAX_INSTRUCTION_BYTES,
  NATIVE_INSTRUCTION_FILE,
  bindingKey,
  classifyInstruction,
  isMissingFileError,
  parseSkillRequests,
  resolveSkills,
  unresolvedSkills,
  type ContextAccounting,
  type InstructionFile,
  type InstructionProbe,
  type ReadinessManifest,
} from '@/lib/coworkReadiness'
import { measureContextPack } from '@/lib/coworkContext'
import {
  CONTINUE_QUESTION_ID,
  decideOpening,
  recordFor,
} from '@/lib/coworkContinuity'
import { CoworkChatTransport } from '@/lib/coworkTransport'
import { CoworkProposalReview } from '@/containers/CoworkProposalReview'
import { CoworkTurnUndo } from '@/containers/CoworkTurnUndo'
import {
  useCoworkWorktrees,
  type WorktreeRecord,
} from '@/hooks/useCoworkWorktrees'
import {
  applyDecision,
  conflictKey,
  parseTeamRequest,
  refuseGraph,
  refuseUnresolved,
  renderTeamReport,
  runTeam,
  scopeConflicts,
  teamProgress,
  TEAM_DEFAULT_PROMPT,
  type TeamState,
  type TeamTask,
} from '@/lib/coworkTeam'
import { useTeamConflictRequests } from '@/hooks/useTeamConflictRequests'
import { CoworkTeamConflicts } from '@/containers/CoworkTeamConflicts'
import { CoworkTeamReviews } from '@/containers/CoworkTeamReviews'
import { CoworkBundleImport } from '@/containers/CoworkBundleImport'
import { CoworkEventExport } from '@/containers/CoworkEventExport'
import { recordEvents } from '@/lib/eventLog'
import { CoworkChildApprovals } from '@/containers/CoworkChildApprovals'
import {
  beginTeamChild,
  settleTeamChild,
  useTeamChildrenVersion,
  type ParallelOverride,
} from '@/lib/teamChildren'
import {
  describeDestinations,
  planDestinations,
  type Destination,
} from '@/lib/coworkTeamDestinations'
import { dispatchCoworkTool } from '@/lib/coworkDispatch'
import { applyTodoOp, renderTodoResult } from '@/lib/coworkTodo'
import { parseAskRequest, renderAskResult } from '@/lib/coworkAsk'
import {
  planReviewDecision,
  renderPlanReviewResult,
} from '@/lib/coworkPlanReview'
import { getSandboxStatus, sandboxEnforces } from '@/lib/agentTools'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { MAX_AGENT_STEPS } from '@/lib/coworkBudget'
import {
  abortRun,
  beginRun,
  endRun,
  hasSubagent,
  registerSubagent,
  unregisterSubagent,
  isAbortLike,
  answerAsk,
  runTurn,
  type RunOutcome,
  type StreamSink,
  type ToolOutcome,
} from '@/lib/coworkRunner'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import {
  listSubagents,
  type SubagentDefinition,
} from '@/lib/coworkSubagentRegistry'
import {
  parseSubagentRequest,
  resolveSubagent,
  parentToolNames,
  runSubagent,
  type SubagentRequest,
} from '@/lib/coworkSubagent'
import { errorText } from '@/lib/errorText'
import { CoworkStopMenu } from '@/containers/CoworkStopMenu'
import { PromptSnapshotView } from '@/containers/PromptSnapshotView'

/** How often the backend's background-job list is re-read. Slower than the
 * activity panel's clock tick: the list changes when a command starts or ends,
 * not every second. */
const JOB_POLL_MS = 3000

export const Route = createFileRoute(route.cowork as any)({
  component: CoworkPage,
})

/** Same shape the other Cowork surfaces use; kept local, as they do. */
/**
 * The window a request has to fit inside, when it is known.
 *
 * Resolved by `useModelCapabilities` (AH-195) rather than read from one
 * settings field: an OpenAI-compatible server reports its window under any of
 * several names, and reading only Jan's own `ctx_len` left every such endpoint
 * permanently "not known". When a local runtime has answered this is its
 * effective `n_ctx`, which `--fit` may have set well below the model's
 * training size -- the smaller number is the real limit.
 */
const configuredContextTokens = (
  caps: { contextTokens: number | null } | null | undefined
): number | null => caps?.contextTokens ?? null

/** Shared so a rejected Tauri command never renders as `[object Object]`. */
const messageOf = errorText

function CoworkPage() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { selectedModel, selectedProvider } = useModelProvider()
  // Resolved once for the route: the readiness card, the context measurement
  // and the run all have to be talking about the same window.
  // The snapshot of the dispatch now in flight, so its reply's usage can be
  // recorded against the payload it actually counted.
  const lastSnapshotRef = useRef<PromptSnapshotRef | null>(null)
  const modelCapabilities = useModelCapabilities(
    selectedModel as never,
    selectedProvider as never
  )

  const sessions = useCoworkSessions((s) => s.sessions)
  const currentId = useCoworkSessions((s) => s.currentId)
  const session = useMemo(
    () => sessions.find((s) => s.id === currentId) ?? null,
    [sessions, currentId]
  )
  const folder = session?.folder ?? null
  const mode = modeOf(session ?? {})

  /**
   * The one description of this run.
   *
   * Both the readiness card and the prompt are built from this, so they cannot
   * end up describing different runs. It carries its binding, so a manifest
   * left over from another folder or session is recognisable rather than
   * merely stale-looking.
   */
  const [confirmDirectEdit, setConfirmDirectEdit] = useState(false)
  /**
   * The binding as it stands right now.
   *
   * A ref rather than the closure's copy: an authorization started before a
   * folder switch has to compare against where the user *is*, not where they
   * were when they pressed the button.
   */
  const bindingRef = useRef<{
    sessionId: string | null
    folder: string | null
  }>({ sessionId: null, folder: null })
  bindingRef.current = { sessionId: session?.id ?? null, folder }

  // A confirmation is about one folder in one session. If either changes while
  // it is open, the question no longer means what it said.
  useEffect(() => {
    setConfirmDirectEdit(false)
  }, [session?.id, folder])

  const [running, setRunning] = useState(false)

  const [liveTurns, setLiveTurns] = useState<CoworkTurn[]>([])
  const liveTurnsRef = useRef<CoworkTurn[]>([])
  const [stoppedBy, setStoppedBy] = useState<RunOutcome['stoppedBy'] | null>(
    null
  )
  const [runError, setRunError] = useState<string | undefined>(undefined)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [projectInstructions, setProjectInstructions] = useState<string | null>(
    null
  )
  // Bumped when Jan itself writes the folder's JAN.md, so it is read again.
  const [instructionsVersion, setInstructionsVersion] = useState(0)
  const [instructionFiles, setInstructionFiles] = useState<InstructionFile[]>(
    []
  )
  const { skills: availableSkills, enabled: enabledSkills } = useSkills(folder)
  const composerPrompt = usePrompt((s) => s.prompt)
  /**
   * How many tools the last run advertised.
   *
   * Set when a run builds its tool set. Null before that, so the readiness
   * card says the set has not been built rather than reporting a count.
   */
  const [advertisedToolCount, setAdvertisedToolCount] = useState<number | null>(
    null
  )
  /**
   * The names, not just the count.
   *
   * An imported agent's requested tools are intersected against these, so
   * whether a definition is usable can be answered before it is launched
   * rather than discovered when a call is refused mid-run.
   */
  const [advertisedToolNames, setAdvertisedToolNames] = useState<string[]>([])
  /**
   * Jan-owned worktrees of this project that are on disk right now.
   *
   * Read from Git, not from anything persisted: the session's own record dies
   * with the process, so after a crash this is the only truthful answer to
   * where an interrupted run's work went. Listing is not authorization —
   * nothing here becomes writable.
   */
  const [foundWorktrees, setFoundWorktrees] = useState<WorktreeRecord[]>([])
  /**
   * What the last run actually sent, by category.
   *
   * Null until a run has built its payload, because before that the categories
   * that depend on it are genuinely unknown — and an unknown must not be shown
   * as a zero. Measured by the transport rather than here, so the card cannot
   * describe a payload the run did not build.
   */
  const [runContext, setRunContext] = useState<ContextAccounting | null>(null)

  const access = accessOf(session ?? {})
  // Asked of the backend rather than assumed here: whether a folder can be
  // edited depends on what the sandbox can confine, which only it knows.
  const capabilityState = useDirectEditGrants((s) => s.capability)
  const liveGrant = useDirectEditGrants((s) =>
    session?.id ? s.bySession[session.id] : undefined
  )
  useEffect(() => {
    void useDirectEditGrants.getState().refreshCapability()
  }, [])

  /**
   * What this session may actually do — the stored preference reconciled with
   * the backend's capability and the grant it is really holding.
   *
   * One derivation, read by the readiness card and the prompt, so the screen
   * cannot describe a destination the dispatcher would not use.
   */
  const worktree = useCoworkWorktrees((s) =>
    session?.id ? s.bySession[session.id] : undefined
  )
  const effective = effectiveAccess({
    persisted: access,
    capability: {
      // Both write modes rest on an authorized writable root the tool gate
      // holds to, but not on the same confinement: on Windows the sandbox can
      // hold a run to a Jan-owned worktree and not to the user's folder. A
      // worktree needs Git as well, which the lifecycle reports by refusing
      // to produce one.
      managedWorktree: capabilityState.known && capabilityState.managedWorktree,
      directEdit: capabilityState.known && capabilityState.directEdit,
    },
    capabilityKnown: capabilityState.known,
    grant: liveGrant ?? null,
    binding: { sessionId: session?.id ?? null, folder },
    worktreePath: worktree?.path ?? null,
  })
  /**
   * The working tree this session's changes land in.
   *
   * The attached folder for a sandbox or direct-edit session, the worktree for
   * a managed one. Every surface that describes changes — the Changes panel,
   * the origin ledger, which root a path belongs to — reads this rather than
   * the attached folder, or a managed run would show an empty diff of a tree
   * nothing touched.
   */
  const treeRoot = effective.readRoot ?? folder

  useEffect(() => {
    let cancelled = false
    if (!folder) {
      setFoundWorktrees([])
      return
    }
    void (async () => {
      const dataFolder = await serviceHub
        .app()
        .getJanDataFolder()
        .catch(() => '')
      if (!dataFolder) return
      const found = await useCoworkWorktrees.getState().list(folder, dataFolder)
      // The folder may have changed during the round trip; a list from the
      // previous repository would offer the wrong work to recover.
      if (!cancelled) setFoundWorktrees(found)
    })()
    return () => {
      cancelled = true
    }
  }, [folder, serviceHub])

  /**
   * This session's origin ledger, if a run has produced one.
   *
   * Keyed by session, so switching sessions shows that session's record and
   * never the last run's. Withdrawing access does not touch it: a grant handed
   * back changes what Jan may do next, not what already happened.
   */
  const runOrigins = useCoworkOrigins((s) =>
    session?.id ? (s.bySession[session.id] ?? null) : null
  )

  /**
   * This folder's Claude configuration, resolved for the binding on screen.
   *
   * Readiness shows it and the run freezes it; nothing scans for itself. Three
   * scans at three moments is three different answers to "what is in force",
   * and the user is shown one of them while another is used.
   */
  const skillRoots = useClaudeCompat((s) => s.skillRoots)
  /**
   * The subagents saved in Jan.
   *
   * Declared before the compatibility scan because the scan needs them: an
   * imported agent that reuses one of these names is a duplicate, and it is
   * reported as one rather than quietly losing.
   */
  const [subagentDefs, setSubagentDefs] = useState<SubagentDefinition[]>([])
  // What `@` can name besides files (AH-204): this folder's skills and the
  // saved agents, offered in the composer's one ranked list.
  const referenceSources = useMemo(
    () => ({
      skills: availableSkills.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
      agents: subagentDefs.map((agent) => ({
        name: agent.name,
        description: agent.description,
      })),
    }),
    [availableSkills, subagentDefs]
  )

  const {
    manifest: compat,
    mcpProbes,
    rescan: rescanCompat,
  } = useCompatManifest({
    binding: { sessionId: session?.id ?? null, folder },
    enabledSkills: new Set(
      effectiveEnabled(
        enabledSkills,
        availableSkills.map((s) => s.name)
      )
    ),
    availableTools: advertisedToolNames,
    // So an imported agent reusing a saved name is reported as a duplicate
    // rather than quietly losing to it.
    savedAgentNames: subagentDefs.map((one) => one.name),
    // Only what the user approved through the picker. Never anything a
    // repository named.
    approvedUserSkillRoots: skillRoots,
  })

  const readiness = useMemo<ReadinessManifest>(() => {
    const registry = mergeSkillRegistry(compat, {
      available: availableSkills.map((skill) => ({ name: skill.name })),
      enabled: new Set(
        effectiveEnabled(
          enabledSkills,
          availableSkills.map((skill) => skill.name)
        )
      ),
    })
    const requested = parseSkillRequests(
      composerPrompt,
      registry.available.map((skill) => skill.name)
    )
    return {
      binding: { sessionId: session?.id ?? null, folder },
      folder,
      branch: gitBranch,
      mode,
      // From the effective access, not the stored preference: a session that
      // remembers "edit this folder" but holds no live grant writes to its
      // sandbox, and the card has to say so.
      writeDestination: effective.destination,
      // Only when that is where writes actually go. A session holding a
      // worktree record but running in Review must not be shown a destination
      // it is not using.
      worktree:
        effective.destination === 'managed' && worktree
          ? {
              path: worktree.path,
              branch: worktree.branch,
              baseSha: worktree.baseSha,
              uncommittedAtCreation: worktree.uncommittedAtCreation,
            }
          : null,
      instructions: instructionFiles,
      // The same merged registry the run resolves against, so the card cannot
      // call a skill available that the run will report missing.
      skills: resolveSkills(requested, registry),
      // Null until a run has built its tool set: before that nothing knows
      // the number, and stating one would be inventing it.
      tools: { builtins: advertisedToolCount, mcpServers: [] },
      model: {
        id: selectedModel?.id ?? null,
        supportsTools: selectedModel
          ? Boolean(selectedModel.capabilities?.includes('tools'))
          : null,
      },
      // From the run's own snapshot when there is one, so the card and the
      // summary cannot disagree about whether anything is attributable.
      evidence: evidenceLimit(runOrigins?.context.baseline ?? null),
      // From the run's own payload once there is one. Before that the
      // categories that depend on it stay unknown rather than zero: a run that
      // has not been built has not sent nothing, it has sent nothing *yet*.
      context:
        runContext ??
        measureContextPack({
          systemPrompt: null,
          toolSchemas: null,
          messages: null,
          configuredContextTokens: configuredContextTokens(modelCapabilities),
        }),
    }
  }, [
    session?.id,
    folder,
    gitBranch,
    mode,
    instructionFiles,
    effective.destination,
    worktree,
    compat,
    runOrigins?.context.baseline,
    advertisedToolCount,
    runContext,
    availableSkills,
    enabledSkills,
    composerPrompt,
    selectedModel,
    modelCapabilities,
  ])

  // Read inside the instruction effect without making the session a dependency:
  // the effect keys on the folder, and the ref is only used to notice that the
  // session changed underneath a read that was already in flight.
  /** The last run's resolved skills, so a retake does not lose them. */
  /**
   * A few words for the session-details trigger: the repository and branch,
   * which is what someone glances at to confirm they are in the right place.
   * The rest lives inside the dialog.
   */
  const sessionDetailsSummary = useMemo(() => {
    const repo = readiness.folder?.split('/').filter(Boolean).pop()
    if (!repo) return ''
    return readiness.branch ? `${repo} · ${readiness.branch}` : repo
  }, [readiness.folder, readiness.branch])

  const runSkillsRef = useRef<ReturnType<typeof resolveSkills>>([])
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = session?.id ?? null
  const workspacePath = useSessionWorkspacePath(session?.id)

  /**
   * Jan's own data folder, so an imported MCP server can be kept out of it.
   *
   * Read once: it does not change while the app is running, and an imported
   * server has no business in the app's storage whatever the repository that
   * named it would like.
   */
  const [janDataFolder, setJanDataFolder] = useState<string | null>(null)
  useEffect(() => {
    void serviceHub
      .app()
      .getJanDataFolder()
      .then((path) => setJanDataFolder(path ?? null))
      .catch(() => setJanDataFolder(null))
  }, [serviceHub])

  const { setConsent: setMcpConsent, revalidate: revalidateMcp } =
    useImportedMcp({
      folder,
      workspacePath,
      dataFolder: janDataFolder,
      // A write root only where the session actually holds one: an imported
      // server never gets authority the run itself does not have.
      writableRepository:
        effective.access === 'edit-folder' ? effective.writeRoot : null,
    })

  /**
   * A definition edited after it was allowed is a different program.
   *
   * Checked whenever the scan produces new definitions: the consent is
   * withdrawn and the running server stopped, rather than left up under a
   * permission that was given for something else.
   */
  useEffect(() => {
    void revalidateMcp(mcpProbes)
  }, [mcpProbes, revalidateMcp])

  // The step just finished, so the counter tracks a run instead of jumping once
  // at the end. Falls back to the committed usage between runs.
  const [liveUsage, setLiveUsage] = useState<Usage | null>(null)
  // The rail holds one panel at a time: preview, diff and code all want the
  // width, so showing two together starves the transcript (C7).
  // Held in a store rather than in this component: stepping into Settings
  // unmounts the route, and coming back must return to the session as it was
  // -- same rail, same place in the transcript -- not to a reset view.
  const railBySession = useCoworkView((s) => s.railBySession)
  const sessionIdForView = session?.id
  const rail = railBySession[sessionIdForView ?? NO_SESSION] ?? null
  // A rail opened before the first message belongs to the session that message
  // starts.
  useEffect(() => {
    if (sessionIdForView) {
      useCoworkView.getState().adoptPreSession(sessionIdForView)
    }
  }, [sessionIdForView])
  const setRail = useCallback(
    (next: CoworkRail) =>
      useCoworkView.getState().setRail(sessionIdForView, next),
    [sessionIdForView]
  )
  // The last artifact previewed this session, so re-opening Preview from the
  // rail toolbar returns to it instead of an empty pane.
  const [lastPreviewPath, setLastPreviewPath] = useState<string | undefined>(
    undefined
  )
  /** Open a tab in the Code panel. `sandbox` marks paths under the session
   * workspace (agent artifacts) rather than the attached project. */
  const openCode = useCallback((tab: CodeTab) => {
    const sid = ensureCurrentSession()
    const store = useCoworkSessions.getState()
    const current = store.sessions.find((s) => s.id === sid)
    store.setCodePanel(
      sid,
      openTab(current?.codePanel ?? emptyCodePanelState(), tab)
    )
    setRail({ kind: 'code' })
  }, [])

  /**
   * Open a path a tool acted on, from its widget in the transcript.
   *
   * The path comes from the tool call's own `path` argument — structured
   * data, never text parsed out of the model's prose. It still has to land in
   * an allowed root: paths under the attached project open as project paths,
   * everything else is treated as the session sandbox, which is the only
   * other place the agent can write. Non-source files are left alone rather
   * than opened as code.
   */
  const openToolPath = useCallback(
    (path: string) => {
      if (!shouldOpenInCode(path)) return
      const projectKey = projectKeyOf(folder)
      const relative = relativeToRoot(folder, path)
      // Only call it a project file when it really resolved inside the project.
      if (projectKey && relative !== path) {
        openCode(projectTab(relative, projectKey))
      } else if (session?.id) {
        openCode(sandboxTab(relativeToRoot(workspacePath, path), session.id))
      }
    },
    [folder, workspacePath, openCode, session?.id]
  )

  /**
   * Which root a path belongs to. The activity record needs this to separate
   * the read-only project from the sandbox the agent writes into.
   */
  const originOfPath = useCallback(
    (path: string): FileOrigin => {
      // Against the tree the run works in, not the attached folder: in a
      // managed session every project path is under the worktree, and matching
      // on the folder would file all of them as external.
      if (treeRoot && relativeToRoot(treeRoot, path) !== path) return 'project'
      if (workspacePath && relativeToRoot(workspacePath, path) !== path)
        return 'sandbox'
      return 'external'
    },
    [treeRoot, workspacePath]
  )

  /**
   * Write the run's origin ledger, from evidence rather than from the model.
   *
   * Successful Jan file calls are the only thing claimed outright. Everything
   * else found differing at the end is either proved pre-existing by the
   * baseline, reported as merely observed during the run, or — with no usable
   * baseline — reported as unknown. A file being inside the repository is
   * never itself treated as evidence of anything.
   */
  const recordOrigins = useCallback(
    async (input: {
      sessionId: string
      origins: RunOrigins
      events: readonly FileActivityEvent[]
    }) => {
      const { sessionId, origins, events } = input
      const { baseline, binding, destination } = origins
      // Where the changes are, which is not always where the session is
      // attached. Falling back to the folder keeps a ledger recorded before
      // this distinction existed readable.
      const tree = origins.tree ?? binding.folder

      const janCalls: JanFileCall[] = events
        .filter((event) => isChange(event.operation) && event.ok)
        .map((event) => ({
          // Compared against Git's repo-relative paths, so a project path has
          // to be expressed the same way before the two can be matched.
          path:
            event.origin === 'project' && tree
              ? relativeToRoot(tree, event.path)
              : event.path,
          destination: destinationOfOrigin(event.origin, destination),
          ok: true,
        }))

      let endDifferences: string[] = []
      if (tree) {
        try {
          const status = await loadGitStatus(tree, 'all')
          endDifferences = (status?.files ?? []).map((file) => file.path)
        } catch {
          // Nothing found is nothing claimed: a failed read leaves the ledger
          // with Jan's own calls and no assertions about anything else.
        }
      }

      const entries = buildOriginLedger({
        baseline,
        janCalls,
        endDifferences,
        destinationOf: (path) =>
          destinationOfOrigin(
            originOfPath(tree ? `${tree}/${path}` : path),
            destination
          ),
      })
      useCoworkOrigins.getState().record(sessionId, {
        entries,
        summary: summarizeRun(entries, baseline, origins),
        at: Date.now(),
      })
    },
    [originOfPath]
  )

  // Source artifacts open as code, not as a plain-text preview dump.
  const showPreview = useCallback(
    (path: string) => {
      // An artifact is something the agent generated: it lives in the session
      // workspace, never in the user's project.
      // An artifact is something the agent generated: it lives in this
      // session's workspace, never in the user's project.
      if (shouldOpenInCode(path) && session?.id) {
        openCode(artifactTab(path, session.id))
      } else {
        setLastPreviewPath(path)
        setRail({ kind: 'preview', path })
      }
    },
    [openCode, session?.id]
  )

  // The rail toolbar's four mutually-exclusive modes map onto the rail state
  // (Changes is the diff panel, Activity the tasks panel). Selecting the active
  // mode again closes it, so the toolbar toggles. Code and Preview open into
  // their own empty states, so neither is ever disabled.
  const selectRail = useCallback(
    (mode: RailMode) => {
      if (mode === 'code') ensureCurrentSession()
      const kind =
        mode === 'changes' ? 'diff' : mode === 'activity' ? 'tasks' : mode
      if (rail?.kind === kind) {
        setRail(null)
        return
      }
      setRail(kind === 'preview' ? { kind, path: lastPreviewPath } : { kind })
    },
    [lastPreviewPath, rail?.kind, setRail, ensureCurrentSession]
  )
  /** The toolbar's semantic mode for the currently open rail, or null. */
  const activeRail: RailMode | null =
    rail?.kind === 'diff'
      ? 'changes'
      : rail?.kind === 'tasks'
        ? 'activity'
        : (rail?.kind ?? null)


  const {
    containerRef: reasoningContainerRef,
    isAtBottom: isReasoningAtBottom,
    handleScroll: handleReasoningScroll,
    forceScrollToBottom: forceScrollReasoningToBottom,
  } = useAutoScroll()

  // Saved definitions name the `task` tool's options. Loaded once: the list is
  // only advertised, so a definition added mid-session applies at the next run.
  useEffect(() => {
    let alive = true
    void listSubagents().then((defs) => {
      if (alive) setSubagentDefs(defs)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!folder) {
      setGitBranch(null)
      return
    }
    invoke<string | null>('agent_git_branch', { project: folder })
      .then(setGitBranch)
      .catch(() => setGitBranch(null))
  }, [folder])

  // Every instruction file at the attached root, in one pass.
  //
  // `JAN.md` is Jan's own and the only one whose text reaches the model.
  // `AGENTS.md` and `CLAUDE.md` are recognised and reported so a repository
  // written for another harness does not look instruction-less — detected is
  // not the same as ingested, and nothing here reads them into the prompt.
  //
  // Read through the same root-contained reader the code panel uses, so this
  // cannot become a way to pull in a file from outside the attached folder.
  useEffect(() => {
    if (!folder) {
      setInstructionFiles([])
      setProjectInstructions(null)
      return
    }
    // The binding this read belongs to. A result for the previous folder must
    // not land on the current one, so it is compared before anything is set.
    const startedFor = bindingKey({ sessionId: sessionIdRef.current, folder })
    let alive = true
    void (async () => {
      const probe = async (
        name: string,
        role: 'native' | 'compatibility'
      ): Promise<InstructionProbe> => {
        try {
          const dataFolder = await serviceHub.app().getJanDataFolder()
          if (!dataFolder)
            return { name, role, error: 'data folder unavailable' }
          const file = await projectReadFile(dataFolder, folder, name, false)
          if (file.binary) return { name, role, error: 'not text' }
          if (file.oversized) {
            return {
              name,
              role,
              content: 'x'.repeat(MAX_INSTRUCTION_BYTES + 1),
            }
          }
          return { name, role, content: file.content }
        } catch (e) {
          const message = messageOf(e)
          // Absent is the ordinary case and is not a failure.
          return isMissingFileError(message)
            ? { name, role }
            : { name, role, error: message }
        }
      }

      const probes = await Promise.all([
        probe(NATIVE_INSTRUCTION_FILE, 'native'),
        ...COMPATIBILITY_INSTRUCTION_FILES.map((name) =>
          probe(name, 'compatibility')
        ),
      ])
      if (!alive) return
      if (
        bindingKey({ sessionId: sessionIdRef.current, folder }) !== startedFor
      ) {
        return
      }
      const files = probes.map(classifyInstruction)
      setInstructionFiles(files)
      // The prompt gets exactly what the card calls active, from the same
      // list, so the two cannot describe different runs.
      const native = files.find((file) => file.role === 'native' && file.active)
      const nativeProbe = probes.find(
        (one) => one.name === NATIVE_INSTRUCTION_FILE
      )
      setProjectInstructions(native ? (nativeProbe?.content ?? null) : null)
    })()
    return () => {
      alive = false
    }
  }, [folder, serviceHub, instructionsVersion])

  // Selected-code references staged by “Add to chat”: the visible prompt gets
  // the concise `@path:start-end` token, and the refs wait here until submit,
  // when the model's copy of the message is expanded with the selected text.
  const pendingRefs = useRef<CodeRef[]>([])
  // Cleared when the session changes *or* when the attached project does: a
  // reference carries the bytes and the path of the project it was taken
  // from, and sending it after a switch would label another project's source
  // as this one's.
  useEffect(() => {
    pendingRefs.current = []
  }, [session?.id, folder])

  const addCodeToChat = useCallback((ref: CodeRef) => {
    pendingRefs.current = [
      ...pendingRefs.current.filter(
        (existing) => codeRefToken(existing) !== codeRefToken(ref)
      ),
      ref,
    ]
    const { prompt, setPrompt } = usePrompt.getState()
    const token = codeRefToken(ref)
    if (!prompt.includes(token)) {
      setPrompt(prompt ? `${prompt.trimEnd()} ${token} ` : `${token} `)
    }
  }, [])

  /**
   * Refuse a folder change while something is still writing, and say why.
   *
   * Asked of the one active-work model rather than of a run flag: a subagent,
   * a foreground shell and a background job can each still touch the old root
   * after the turn that started them has ended.
   */
  const folderHeld = useCallback(
    (sessionId: string | null | undefined) => {
      if (authorityMayChange(sessionId)) return false
      const kind = useCoworkActiveWork.getState().blockingKind(sessionId)
      toast.error(t('common:coworkAccess.folderHeld'), {
        description: kind ? t(`common:coworkAccess.busy.${kind}`) : undefined,
      })
      return true
    },
    [t]
  )

  const attachFolder = useCallback(async () => {
    // Checked before the dialog and again after it: the picker is modal to
    // Jan, but a run started before it opened is still going behind it.
    if (folderHeld(session?.id)) return
    const picked = await serviceHub.dialog().open({ directory: true })
    if (typeof picked !== 'string') return
    if (folderHeld(session?.id)) return
    const sid = ensureCurrentSession()
    useCoworkSessions.getState().setFolder(sid, picked)
  }, [serviceHub, session?.id, folderHeld])

  const detachFolder = useCallback(() => {
    if (!session?.id || folderHeld(session.id)) return
    useCoworkSessions.getState().setFolder(session.id, null)
  }, [session?.id, folderHeld])

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
  // A presentation filter: the turns themselves are untouched, so turning the
  // option off puts the activity straight back without a reload.
  const hideCompletedToolsSetting = useCoworkDisplay((s) => s.hideCompletedTools)
  // A temporary look at what is hidden. Not persisted, and reset whenever the
  // setting itself changes, so it never silently overrides the preference.
  const [revealHiddenTools, setRevealHiddenTools] = useState(false)
  useEffect(() => setRevealHiddenTools(false), [hideCompletedToolsSetting])
  const hideCompletedTools = hideCompletedToolsSetting && !revealHiddenTools
  const uiMessages = useMemo(
    () =>
      coworkTurnsToUIMessages(displayedTurns, session?.id ?? 'cowork', {
        hideCompletedTools,
      }),
    [displayedTurns, session?.id, hideCompletedTools]
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
  const tokenSource = useMemo(
    () => ({
      threadId: session?.id,
      usage: usage
        ? {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }
        : undefined,
    }),
    [session?.id, usage]
  )

  // Live runs write into the run store; a committed session carries its own.
  const liveSubagents = useCoworkRun((s) =>
    session?.id ? s.subagents[session.id] : undefined
  )
  const fileDiffs = useMemo(
    () =>
      collectCodeFileDiffs(
        displayedTurns,
        liveSubagents ?? session?.subagents ?? []
      ),
    [displayedTurns, liveSubagents, session?.subagents]
  )

  // Read-only working-tree status for the attached repo, loaded lazily and kept
  // strictly separate from the sandbox diffs above. The chip's counts combine
  // both sources so it appears whenever either has changes.
  const git = useCoworkGitStatus(treeRoot)

  /**
   * Ask the backend to authorize this folder, then switch the session.
   *
   * In that order, and only in that order: switching first would show
   * "editable" for however long the round trip takes, which is exactly the
   * claim-without-authority this model exists to prevent. A refusal leaves the
   * session where it was.
   */
  const authorizeDirectEdit = useCallback(async (): Promise<boolean> => {
    const sid = session?.id ?? null
    const done = useCoworkActiveWork.getState().acquire({
      sessionId: sid ?? 'none',
      kind: 'authorizing',
      authority: {
        folder,
        access: effective.access,
        destination: effective.destination,
      },
    })
    try {
      const dataFolder = await serviceHub.app().getJanDataFolder()
      const result = await runAuthorizeDirectEdit({
        binding: { sessionId: sid, folder },
        dataFolder: dataFolder ?? null,
        authorize: (sessionId, target, data) =>
          useDirectEditGrants.getState().authorize(sessionId, target, data),
        revokeSession: (sessionId) =>
          useDirectEditGrants.getState().revokeSession(sessionId),
        // Read after the await, so it sees where the user actually is.
        currentBinding: () => bindingRef.current,
        setAccess: (sessionId) =>
          useCoworkSessions.getState().setAccess(sessionId, 'edit-folder'),
      })
      if (result === 'granted') setConfirmDirectEdit(false)
      return result === 'granted'
    } finally {
      done()
    }
  }, [session?.id, folder, serviceHub, effective.access, effective.destination])

  /**
   * Create or find this session's worktree, authorize it, then switch.
   *
   * The same order as direct editing and for the same reason: switching first
   * would show "isolated worktree" while the backend still refused every write
   * outside the sandbox. A failure at either step leaves the session where it
   * was, saying what is true.
   *
   * The grant names the *worktree*, never the source checkout — which is what
   * makes this mode structurally unable to write the tree it exists to protect,
   * rather than merely instructed not to.
   */
  const authorizeManagedWorktree = useCallback(async (): Promise<boolean> => {
    const sid = session?.id ?? null
    if (!sid || !folder) return false
    const done = useCoworkActiveWork.getState().acquire({
      sessionId: sid,
      kind: 'authorizing',
      authority: {
        folder,
        access: effective.access,
        destination: effective.destination,
      },
    })
    try {
      const dataFolder = await serviceHub.app().getJanDataFolder()
      if (!dataFolder) return false
      const created = await useCoworkWorktrees
        .getState()
        .ensure(sid, folder, dataFolder)
      if (!created.ok) {
        toast.error(created.reason)
        return false
      }
      // The user may have moved on during the round trip; authorizing for a
      // binding nobody is looking at would leave authority nobody asked for.
      const now = bindingRef.current
      if (now.sessionId !== sid || now.folder !== folder) return false

      const granted = await useDirectEditGrants
        .getState()
        .authorize(sid, created.record.path, dataFolder)
      if (!granted.ok) {
        if (granted.reason !== 'superseded') toast.error(granted.reason)
        return false
      }
      useCoworkSessions.getState().setAccess(sid, 'managed-worktree')
      return true
    } finally {
      done()
    }
  }, [session?.id, folder, serviceHub, effective.access, effective.destination])

  /**
   * Withdraw first, then downgrade.
   *
   * If revocation fails the session is left saying what is true — the backend
   * may still hold authority — rather than showing read-only over a grant that
   * is still live.
   */
  const returnToReviewOnly = useCallback(async () => {
    const sid = session?.id
    if (!sid) return
    const done = useCoworkActiveWork.getState().acquire({
      sessionId: sid,
      kind: 'revoking',
      authority: {
        folder,
        access: effective.access,
        destination: effective.destination,
      },
    })
    try {
      const revoked = await useDirectEditGrants.getState().revokeSession(sid)
      useCoworkSessions.getState().setAccess(sid, 'review-only')
      if (!revoked) {
        toast.error(t('common:coworkAccess.confirm.revokeFailed'))
      }
    } finally {
      done()
    }
  }, [session?.id, folder, t, effective.access, effective.destination])

  /** What the confirmation states, gathered before the question is asked. */
  const directEditFacts: DirectEditFacts = {
    folder: folder ?? '',
    name: folder?.split(/[\\/]/).pop() ?? '',
    branch: gitBranch,
    git: git.error
      ? 'unknown'
      : git.status
        ? git.status.files.length > 0
          ? 'dirty'
          : 'clean'
        : 'not-a-repo',
    runMode: mode,
    shellAvailable: sandboxEnforces(),
    backend: capabilityState.known
      ? capabilityState.directEdit
        ? t('common:coworkAccess.confirm.shellYes')
        : t('common:coworkAccess.unsupportedPlatform')
      : t('common:coworkAccess.capabilityLoading'),
  }
  /**
   * What this session changed, and only that.
   *
   * The counts used to include the attached repository's whole dirty working
   * tree, so a branch someone left half-finished was reported as Jan having
   * written forty files. That is a false claim about authorship, not a
   * generous count.
   */
  const changeCounts = useMemo(
    () => janAuthoredChanges(fileDiffs, git.status),
    [fileDiffs, git.status]
  )

  // Background shell jobs, polled here rather than inside the Activity panel:
  // the chip derives its counts from the same list, and polling only while the
  // panel was open let the two disagree — a collected job still spinning in the
  // chip while the panel showed it finished.
  const [liveJobs, setLiveJobs] = useState<LiveJob[]>([])
  useEffect(() => {
    let alive = true
    const poll = () => {
      void bashJobsList()
        .then((jobs) => {
          if (alive) setLiveJobs(jobs)
        })
        .catch(() => {
          // No backend (web build, or the command unavailable): the list still
          // shows what the transcript knows.
        })
    }
    poll()
    const id = setInterval(poll, JOB_POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  /**
   * What is holding this session's authority in place, if anything.
   *
   * Runs, subagents, shells and transitions register themselves while they can
   * still write. Background jobs are polled rather than lifecycle-driven, so
   * they are folded in here rather than pretending to be acquired.
   */
  const activeWorkItems = useCoworkActiveWork((s) => s.items)
  const blockingKind: WorkKind | null = useMemo(() => {
    const sid = session?.id
    if (!sid) return null
    const order: WorkKind[] = [
      'run',
      'subagent',
      'shell',
      'job',
      'authorizing',
      'revoking',
    ]
    const mine = Object.values(activeWorkItems).filter(
      (one) => one.sessionId === sid
    )
    return (
      order.find((kind) => mine.some((one) => one.kind === kind)) ??
      (liveJobs.some((job) => !job.finished) ? 'job' : null)
    )
  }, [session?.id, activeWorkItems, liveJobs])

  // The one activity record. The panel, the chip and every inline workflow
  // card select from this, so none of them can disagree about the same work.
  const activityWorkflows = useCoworkActivity((s) => s.workflows)
  const activityTasks = useCoworkActivity((s) => s.tasks)
  const activity = useMemo(
    () => ({ workflows: activityWorkflows, tasks: activityTasks }),
    [activityWorkflows, activityTasks]
  )
  const workflowViews = useMemo(
    () => sessionWorkflows(activity, session?.id),
    [activity, session?.id]
  )
  const taskCounts = useMemo(
    () => sessionTotals(activity, session?.id),
    [activity, session?.id]
  )

  // The backend is the authority on whether a backgrounded shell is still
  // running: the agent may not collect a job for many turns, and until it does
  // nothing else would ever settle that row.
  useEffect(() => {
    const state = useCoworkActivity.getState()
    for (const job of liveJobs) {
      if (!job.finished) continue
      const task = findTaskByJob(state, job.jobId)
      if (task && task.status === 'running') {
        state.patchTask(task.id, { status: 'done', endedAt: Date.now() })
      }
    }
  }, [liveJobs])

  // Advances the cards' elapsed labels. Only while work is live: an idle
  // conversation must not re-render every second.
  const [activityNow, setActivityNow] = useState(() => Date.now())
  const activityActive = taskCounts.running + taskCounts.queued > 0
  useEffect(() => {
    if (!activityActive) return
    const id = setInterval(() => setActivityNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [activityActive])

  // A task the inline card asked the panel to reveal.
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null)
  const [focusWorkflowId, setFocusWorkflowId] = useState<string | null>(null)
  const showTaskInPanel = useCallback((task: ActivityTask) => {
    setRail({ kind: 'tasks' })
    setFocusWorkflowId(task.workflowId)
    setFocusTaskId(task.id)
  }, [])
  const showWorkflowInPanel = useCallback((workflowId: string) => {
    setRail({ kind: 'tasks' })
    setFocusTaskId(null)
    setFocusWorkflowId(workflowId)
  }, [])

  // Whether the run still holds a controller for an agent task. Consulted
  // rather than assumed, so a Stop control is only offered where pressing it
  // would reach something.
  const sessionId = session?.id
  const agentReachable = useCallback(
    (task: ActivityTask) =>
      sessionId != null && hasSubagent(sessionId, task.id),
    [sessionId]
  )

  const applyCancel = useCallback(
    (
      task: ActivityTask,
      result: Awaited<ReturnType<typeof cancelTaskRequest>>
    ) => {
      const patch = patchForOutcome(result, Date.now())
      if (patch) useCoworkActivity.getState().patchTask(task.id, patch)
      return patch != null
    },
    []
  )

  const cancelTask = useCallback(
    async (task: ActivityTask) => {
      if (!session?.id) return
      const result = await cancelTaskRequest(session.id, task)
      // Nothing was stopped. Say which of the reasons it was rather than
      // leaving the row looking as though the click did nothing.
      if (!applyCancel(task, result)) toast.info(cancelMessage(result, t))
    },
    [session?.id, applyCancel, t]
  )

  const cancelWorkflowTasks = useCallback(
    async (view: WorkflowView) => {
      if (!session?.id) return
      const outcome = await cancelWorkflowRequest(session.id, view, {
        agentReachable,
      })
      const byId = new Map(view.tasks.map((task) => [task.id, task]))
      for (const result of outcome.results) {
        const task = byId.get(result.taskId)
        if (task) applyCancel(task, result)
      }
      // Honest about a partial result: some children stopped, some did not.
      if (outcome.failed > 0) {
        toast.info(
          t('common:tasks.stopWorkflowPartial', {
            cancelled: outcome.cancelled,
            failed: outcome.failed,
          })
        )
      }
    },
    [session?.id, agentReachable, applyCancel, t]
  )

  const awaitingModel = useMemo(
    () => awaitsModel(running, displayedTurns),
    [running, displayedTurns]
  )

  const pushLive = useCallback((turns: CoworkTurn[]) => {
    // AH-078. Bind each assistant row to the dispatch that produced it, here,
    // because here is where the row first exists.
    //
    // Every previous attempt wrote the reference at snapshot time, from the
    // sink. Instrumenting the live lane in the running app showed why none of
    // them worked: at dispatch the lane holds the user turn and nothing else,
    // so there is no assistant row to write onto and the write silently does
    // nothing. Unit tests missed it because they hand the mutation an array
    // that already contains one.
    //
    // `lastSnapshotRef` is the dispatch that just went out, so a continuation,
    // a retry and a compaction each carry their own -- which position-based
    // matching cannot express, and which is the open part of this item.
    const stamped = turns.map((turn) =>
      turn.role === 'assistant' && !turn.promptSnapshot && lastSnapshotRef.current
        ? { ...turn, promptSnapshot: lastSnapshotRef.current }
        : turn
    )
    liveTurnsRef.current = [...liveTurnsRef.current, ...stamped]
    setLiveTurns(liveTurnsRef.current)
  }, [])

  /**
   * Change the live turns this route is actually rendering.
   *
   * There are two live-turn lanes: the run store's, and this ref-backed copy,
   * and only this one reaches the screen. A question attached to the store's
   * lane is recorded correctly and never rendered.
   */
  const mutateLive = useCallback(
    (apply: (turns: CoworkTurn[]) => CoworkTurn[]) => {
      const next = apply(liveTurnsRef.current)
      if (next === liveTurnsRef.current) return
      liveTurnsRef.current = next
      setLiveTurns(next)
    },
    []
  )

  /**
   * Drive one request. `text` is null for a resume — a retry after a failure
   * re-runs the committed history rather than re-sending the question, which
   * would leave the model reading it twice.
   */
  const runRequest = async (text: string | null) => {
    if (running) return
    const sid = ensureCurrentSession()
    const store = useCoworkSessions.getState()
    const current = store.sessions.find((s) => s.id === sid)
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
    // Jan's own skills and this folder's compatible ones, resolved as one
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
        ? runSkillsRef.current
        : resolveSkills(parseSkillRequests(text, skillNames), runRegistry)
    runSkillsRef.current = runSkills
    if (!text && !(current?.messages?.length ?? 0)) return
    if (!selectedModel?.id) {
      toast.error(t('common:selectModel'))
      return
    }
    // Without tool calling the transport drops the tool set silently, and the
    // agent then narrates work it never did. Refusing up front is honest; a
    // toolless "agent" run is worse than no run.
    if (!selectedModel.capabilities?.includes('tools')) {
      toast.error(t('common:modelNoTools', { model: selectedModel.id }))
      return
    }
    if (text && current?.title === 'New session')
      store.setTitle(sid, text.slice(0, 40))

    /**
     * A managed worktree still being the thing this session recorded.
     *
     * Checked before the run rather than trusted from the record, because
     * everything that invalidates one happens outside Jan: the directory
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
        return
      }
    }

    setStoppedBy(null)
    setRunError(undefined)
    setLiveUsage(null)
    liveTurnsRef.current = text ? [{ role: 'user', content: text }] : []
    setLiveTurns(liveTurnsRef.current)
    useCoworkRun.getState().resetSubagents(sid)
    setRunning(true)
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

    // Local models load before the first token, but only on a cold start. Probe
    // the engine so the load card shows on a real load, not on every warm run.
    if (selectedProvider === 'llamacpp') {
      try {
        const loaded = await getLoadedModels()
        if (!loaded.includes(selectedModel.id)) {
          useAppState.getState().updateModelLoadProgress(undefined)
          useAppState.getState().updateLoadingModel(true)
        }
      } catch {
        // Probe failed; skip the card rather than flash it every run.
      }
    }

    /**
     * What the working tree looked like before this run touched anything.
     *
     * Taken here, before the first tool call, because it is the only moment
     * that can answer "was this already different?" — and that question is
     * what stops the run's own report from handing the user their existing
     * uncommitted work back as something Jan did. Bound to the session and
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
    let runBaseline: GitBaseline | null = null
    if (carried.readRoot) {
      let captured: GitBaseline
      try {
        captured = baselineFromStatus(
          await loadGitStatus(carried.readRoot, 'all'),
          baselineBinding
        )
      } catch {
        // Git failing is not the same as a folder having no Git: with no
        // before-state, nothing found later can be dated at all.
        captured = unavailableBaseline(baselineBinding)
      }
      runBaseline = acceptBaseline(captured, bindingRef.current)
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
      baseline: runBaseline,
    }
    useCoworkOrigins.getState().begin(sid, origins)

    /**
     * A point this run can be taken back to.
     *
     * Only where Jan is about to change something: a review run writes
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
     * The agents this run can dispatch: Jan's own, plus the repository's.
     *
     * Frozen with the manifest, so an agent file edited mid-run applies to the
     * next one. Jan's saved definitions win a name collision — a repository
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
    await getSandboxStatus()
    // Read once per run, not subscribed: the advertised set is frozen for the
    // run anyway, so a mid-run flip in Settings would only desync the prompt.
    const webSearch = useWebSearchConfig.getState().webSearchEnabled
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
    })
    const inspecting = opening === 'inspect-and-propose'
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
    const transport = new CoworkChatTransport(sid, {
      planMode: isReadOnly(runMode),
      subagentNames: runAgents.map((d) => d.name),
      // Always on at depth 0, even with nothing saved: a one-off subagent with
      // an inline `system_prompt` is first-class, as it is in Rust.
      allowSubagents: true,
      webSearch,
      workspacePath,
      readOnlyFolder: runReadRoot,
      // Read from the run's frozen snapshot, not re-derived here: the model
      // must be told exactly what the gate and the ledger will act on.
      folderAccess: promptFolderAccess(origins),
      gitBranch,
      projectInstructions,
      // Only what the resolver made active: a file that is present but not
      // switched on, oversized, or pointing outside the folder contributes
      // nothing here.
      compatInstructions: compatInstructionBlocks(runCompat),
      openingInspection: inspecting,
    })
    await transport.refreshTools()
    // Now the count is a fact rather than a guess, so the readiness card can
    // stop saying the tool set has not been built.
    const advertised = Object.keys(transport.advertisedTools)
    setAdvertisedToolCount(advertised.length)
    setAdvertisedToolNames(advertised)

    const controller = new AbortController()
    abortRef.current = controller
    // One run, one workflow id. Registering the run is what makes stopping it —
    // as a whole, or one dispatched child at a time — actually reach anything.
    const runId = crypto.randomUUID()
    beginRun(sid, runId, controller)
    // AH-005: the run's first canonical event. The title is the user's own
    // words, so it is content: a metadata-only export leaves it out.
    recordEvents([
      {
        id: `run:${runId}:started`,
        session: sid,
        run: runId,
        kind: 'run.started',
        payload: { model: selectedModel.id, title: text },
      },
    ])
    // Missing-path reads this run has seen, shared by the run and its
    // children and dropped with it (janhq/jan#8906).
    const runReadFailures = new Map<string, number>()
    const run: RunContext = {
      sessionId: sid,
      runId,
      // The turn's own question, or the one being taken again.
      title:
        text ||
        lastUserQuestion(current?.messages) ||
        t('common:tasks.untitledRun'),
      model: selectedModel.id,
    }

    const sink: StreamSink = {
      onText: (delta) => {
        const last = liveTurnsRef.current[liveTurnsRef.current.length - 1]
        if (last && last.role === 'assistant') {
          last.content += delta
          setLiveTurns([...liveTurnsRef.current])
        } else {
          pushLive([{ role: 'assistant', content: delta }])
        }
      },
      onToolStart: (callId, name) =>
        pushLive([
          { role: 'tool', content: '', callId, name, status: 'running' },
        ]),
      onToolArgsDelta: () => {},
      onToolCall: (call) => {
        const row = liveTurnsRef.current.find(
          (turn) => turn.callId === call.toolCallId
        )
        if (row) {
          row.args = call.input
          setLiveTurns([...liveTurnsRef.current])
        }
        // A shell command is background work the moment it starts, and its
        // arguments are the only place the command line exists.
        const command = commandOf(call.input)
        if (command) {
          recordShellDispatch(run, {
            callId: call.toolCallId,
            command,
            anchorMessageId: anchorMessageId(),
          })
          recordEvents([
            {
              id: `job:${call.toolCallId}:started`,
              session: run.sessionId,
              run: run.runId,
              kind: 'job.started',
              payload: { tool: 'bash', command },
            },
          ])
        }
      },
    }

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
          ...liveTurnsRef.current,
        ],
        sid
      )
    // The transcript shows `text` as typed; the model additionally receives the
    // staged code references expanded under it (exact path, line range and the
    // selected source). Only content the user explicitly selected travels.
    const modelText = text ? expandCodeRefs(text, pendingRefs.current) : text
    pendingRefs.current = []
    /**
     * Run one child, and record it.
     *
     * Shared by `task` and `team` rather than written twice: a team's children
     * are this run's children, and they must inherit exactly the same frozen
     * authority, the same dispatcher, the same cancellation and the same
     * activity records. A second copy of this would be a second set of rules,
     * and the one that drifted would be the one nobody was watching.
     */
    const dispatchChild = async (
      callId: string,
      req: SubagentRequest,
      teamSignal?: AbortSignal,
      parentTaskId?: string,
      /**
       * A checkout of this child's own, when a team asked for one.
       *
       * Everything that names where work goes moves together: the root the
       * child is told about, the root the gate resolves, and the owner id the
       * grant was issued to. Passing only some of them is how a child ends up
       * writing one place while being told about another.
       */
      destination?: Destination
    ): Promise<ToolOutcome> => {
      const childFolder = destination?.path ?? runReadRoot
      const childGrant = destination ? destination.grantId : runGrant
      const childOwner = destination?.ownerId ?? sid
      const resolved = resolveSubagent(
        req,
        runAgents,
        parentToolNames(transport.advertisedTools)
      )
      if ('error' in resolved) {
        return { output: `ERROR: ${resolved.error}`, isError: true }
      }
      if (!transport.model) {
        return {
          output:
            'ERROR: no model is loaded for this run, so no subagent can start',
          isError: true,
        }
      }
      // Recorded before the child starts: the dispatch is the only
      // moment the agent name, description and model are known
      // together, and the record has to exist for the queue position
      // that arrives next to land on something.
      recordEvents([
        {
          id: `agent:${run.runId}:${callId}:dispatched`,
          session: run.sessionId,
          run: run.runId,
          kind: 'agent.dispatched',
          payload: { agent: resolved.name, model: selectedModel.id, description: req.description },
        },
      ])
      recordAgentDispatch(run, {
        callId,
        agentName: resolved.name,
        description: req.description,
        model: selectedModel.id,
        // A team's children hang under the team's own row, so the panel shows
        // one piece of work with parts rather than several unrelated errands.
        parentTaskId,
        anchorMessageId: anchorMessageId(),
      })
      // Its own controller, chained to the run's, so this one child
      // can be stopped without stopping the turn.
      const childTaskId = taskIdFor(sid, runId, callId)
      const childAbort = registerSubagent(sid, childTaskId)
      const stopChild = () => childAbort.abort('cancelled')
      controller.signal.addEventListener('abort', stopChild, {
        once: true,
      })
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
       * A child stopped by the run's own Stop is cancelled, not
       * failed: the abort is why it ended. Anything already settled
       * — the panel's per-task Stop writes `cancelled` first — keeps
       * the status it has, because the guard in `updateTask` refuses
       * to overwrite a finished one.
       */
      const settleChild = (isError: boolean, output?: string) => {
        const aborted = childAbort.signal.aborted
        useCoworkActivity.getState().patchTask(childTaskId, {
          ...(output != null ? { output } : {}),
          status: aborted
            ? ('cancelled' as const)
            : isError
              ? ('error' as const)
              : ('done' as const),
          endedAt: Date.now(),
          ...(aborted ? { detail: CANCELLED_BY_USER } : {}),
        })
      }
      try {
        const child = await runSubagent({
          resolved,
          description: req.description,
          // The parent's instance: a second one would mean a second
          // llama-server load for the same model.
          model: transport.model,
          parentTools: transport.advertisedTools,
          system: {
            workspacePath,
            readOnlyFolder: childFolder,
            bashAvailable: sandboxEnforces(),
            // The parent's frozen answers, handed down unchanged: a
            // child never resolves its own access or its own
            // instructions.
            folderAccess: promptFolderAccess(origins),
            projectInstructions,
            compatInstructions: compatInstructionBlocks(runCompat),
          },
          signal: childAbort.signal,
          sessionTokens: 0,
          // A child never gets `todo`/`ask`/`task`, so these refuse
          // rather than execute: a model can still emit a call to a
          // tool that was never advertised.
          dispatch: (call, toolSignal) =>
            dispatchCoworkTool(call, {
              // Recorded under the parent's run and this child's own name, so
              // the timeline shows which agent did a thing without splitting
              // the run it belongs to.
              activity: {
                session: sid,
                run: runId,
                agent: resolved.name,
                project: workspacePath ?? '',
              },
              // The owner the grant was issued to, not the run's session: an
              // isolated child's authority is its own, and the backend refuses a
              // grant presented under any other id.
              sessionId: childOwner,
              readOnlyFolder: childFolder,
              mode: runMode,
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
              onApprove: (callId, toolName, _input, preview) =>
                useToolApprovalRequests
                  .getState()
                  .requestApproval(
                    callId,
                    toolName,
                    sid,
                    undefined,
                    preview,
                    destination
                      ? `${resolved.name} (its own checkout)`
                      : resolved.name
                  ),
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
              onTask: async () => ({
                output: 'A subagent cannot dispatch subagents.',
                isError: true,
              }),
            }, toolSignal),
          events: {
            onQueued: (waiting) => {
              useCoworkRun
                .getState()
                .queueSubagent(sid, callId, resolved.name, waiting)
              activity.patchTask(childTaskId, {
                status: 'queued',
                waiting,
              })
            },
            onStart: () => {
              useCoworkRun.getState().startSubagent(sid, callId, resolved.name)
              activity.patchTask(childTaskId, {
                status: 'running',
                waiting: undefined,
                startedAt: Date.now(),
              })
            },
            onInner: (event) => {
              useCoworkRun.getState().routeIntoSubagent(sid, callId, event)
              // Mirrored onto the record so the panel can show the
              // child's own trace without reaching into the run store.
              const turns = (useCoworkRun.getState().subagents[sid] ?? []).find(
                (one) => one.runId === callId
              )?.turns
              if (turns) {
                activity.patchTask(childTaskId, {
                  transcript: turns,
                  toolCount: countToolCalls(turns),
                })
              }
            },
            onEnd: (usage) => {
              useCoworkRun.getState().endSubagent(sid, callId, usage)
              // Usage only. `onEnd` fires for *every* ending — an
              // abort before the child even starts, a failed model
              // step, an exhausted step budget — so writing a terminal
              // status here would record every one of them as success,
              // and the finished-status guard would then refuse the
              // real outcome that arrives a moment later.
              activity.patchTask(childTaskId, {
                usage: usage ?? undefined,
              })
            },
          },
        })
        useCoworkRun.getState().attachSubagentOutput(sid, callId, child.output)
        settleChild(Boolean(child.isError), child.output)
        return { output: child.output, isError: child.isError }
      } finally {
        controller.signal.removeEventListener('abort', stopChild)
        unregisterSubagent(sid, childTaskId)
        // A throw from the dispatch would otherwise leave the record
        // running with nothing left to finish it.
        settleChild(true)
      }
    }

    const messages = text
      ? [
          ...baseMessages,
          {
            id: `${sid}-user-${baseMessages.length}`,
            role: 'user',
            parts: [{ type: 'text', text: modelText }],
          } as any,
        ]
      : [...baseMessages]

    // Measured here rather than at tool-refresh time because this is where the
    // payload exists: `messages` is what the request carries, and the transport
    // adds the system prompt and the advertised tools to it. Measuring earlier
    // would report a conversation one turn short of the one being sent.
    const measured = transport.measureContext(
      messages,
      configuredContextTokens(modelCapabilities)
    )
    setRunContext(measured)

    /**
     * Check the window before dispatching, not after the server complains.
     * AH-088.
     *
     * A request that fills the window leaves the model nowhere to answer, and
     * some providers respond to that by silently dropping the front of the
     * conversation -- so the run continues, having quietly forgotten what it
     * was asked. Refusing here keeps the failure visible and the transcript
     * intact. An unknown window is never a refusal: it is a limit Jan could
     * not discover, not a limit that was exceeded.
     */
    const accounted = accountedTotal(measured)
    const plan = planTurn({
      projected: accounted.tokens,
      window: measured.budget.known === false ? null : measured.budget.tokens,
    })
    const overflow =
      plan.status === 'over' && accounted.complete
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

    let outcome: RunOutcome | null = null
    let thrown: Pick<RunOutcome, 'stoppedBy' | 'errorText'> | null = null
    try {
      // Raised here rather than returned earlier so the turn is torn down the
      // way every other ending is: the user's own message is committed, the
      // run is closed and nothing is left running.
      if (overflow) throw overflow
      outcome = await runTurn({
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
        deps: {
          sendStep: (msgs, signal) =>
            transport.sendMessages({
              chatId: sid,
              messages: msgs,
              abortSignal: signal,
              trigger: 'submit-message',
              messageId: undefined,
            } as any),
          dispatch: (call, toolSignal) =>
            dispatchCoworkTool(call, {
              activity: { session: sid, run: runId, agent: 'main' },
              sessionId: sid,
              readOnlyFolder: runReadRoot,
              mode: runMode,
              readFailures: runReadFailures,
              writeGrant: runGrant,
              // The same frozen answers the first gate used, so the two cannot
              // disagree about what this run may change.
              access: effective.access,
              accessCapability: runCapability,
              editConsent: runConsent,
              worktreePath: runWorktreePath,
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
              // The prompt the chat surface already uses for tool approval,
              // not a second one: it honours grants the user has already made
              // and renders in the tool card the call is reported in.
              onApprove: (callId, toolName, _input, preview) =>
                useToolApprovalRequests
                  .getState()
                  .requestApproval(callId, toolName, sid, undefined, preview),
              // A shell handed to the backend outlives a cancelled run, so it
              // holds the authority it started with until the process is done.
              trackShell: () =>
                useCoworkActiveWork.getState().acquire({
                  sessionId: sid,
                  kind: 'shell',
                  authority: runAuthority,
                }),
              // The child inherits this run's frozen authority and holds it
              // for as long as it runs. It cannot widen it: this is the only
              // authority handed down.
              trackSubagent: () =>
                useCoworkActiveWork.getState().acquire({
                  sessionId: sid,
                  kind: 'subagent',
                  authority: runAuthority,
                }),
              scopedInstructions: scopedInstructionsFor,
              onTodo: async (input) => {
                const result = applyTodoOp(
                  useCoworkSessions
                    .getState()
                    .sessions.find((s) => s.id === sid)?.todos,
                  input
                )
                if (result.error) {
                  return { output: `ERROR: ${result.error}`, isError: true }
                }
                useCoworkSessions.getState().setTodos(sid, result.list)
                return { output: renderTodoResult(result.list) }
              },
              onAsk: (callId, input) =>
                new Promise<ToolOutcome>((resolve) => {
                  const parsed = parseAskRequest(input)
                  if (typeof parsed === 'string') {
                    resolve({ output: `ERROR: ${parsed}`, isError: true })
                    return
                  }
                  // In the transcript, at the point the run asked -- not in a
                  // slot above the composer. It stays there once answered.
                  const askRecord = {
                    requestId: callId,
                    request: parsed,
                    sessionId: sid,
                    callId,
                    at: new Date().toISOString(),
                    state: 'pending' as const,
                  }
                  useCoworkRun.getState().attachAsk(sid, askRecord)
                  if (sid === sessionIdRef.current) {
                    mutateLive((turns) => attachAskToTurns(turns, askRecord))
                  }
                  // The opening turn ends on a named question. Recording the
                  // wait is what makes a session reopened at this point restore
                  // an unanswered proposal rather than resume into work.
                  const proposal = parsed.questions.find(
                    (one) => one.id === CONTINUE_QUESTION_ID
                  )
                  if (proposal && current?.folder) {
                    useCoworkSessions.getState().setContinuity(sid, {
                      state: 'awaiting-continuation',
                      folder: current.folder,
                      proposal: proposal.question,
                    })
                  }
                  askResolvers.current.set(callId, (answers) => {
                    const state = answers ? 'answered' : 'cancelled'
                    useCoworkRun
                      .getState()
                      .settleAsk(sid, callId, state, answers ?? undefined)
                    if (sid === sessionIdRef.current) {
                      mutateLive((turns) =>
                        settleAskInTurns(
                          turns,
                          callId,
                          state,
                          answers ?? undefined
                        )
                      )
                    }
                    // An answered proposal is no longer outstanding. Declining
                    // is recorded as a decision, not as work to pick up later.
                    if (proposal && current?.folder) {
                      useCoworkSessions.getState().setContinuity(sid, {
                        state: answers ? 'executing' : 'cancelled',
                        folder: current.folder,
                        proposal: proposal.question,
                      })
                    }
                    // A plan review changes the session's mode, from the next
                    // message: this run's tools are frozen. Only ever towards
                    // Ask, where each change still waits for the user.
                    const review = planReviewDecision(parsed, answers)
                    if (review === 'execute' || review === 'exit') {
                      useCoworkSessions.getState().setMode(sid, 'ask')
                    }
                    resolve(
                      review === 'none'
                        ? renderAskResult(answers)
                        : renderPlanReviewResult(review, answers)
                    )
                  })
                }),
              onTask: async (callId, input) => {
                const req = parseSubagentRequest(input)
                if (typeof req === 'string') {
                  return { output: `ERROR: ${req}`, isError: true }
                }
                return dispatchChild(callId, req)
              },
              onTeam: async (callId, input) => {
                const parsed = parseTeamRequest(input)
                if (typeof parsed === 'string') {
                  return { output: `ERROR: ${parsed}`, isError: true }
                }
                let tasks: TeamTask[] = parsed
                // Refused here rather than inside `runTeam`, so a graph that
                // cannot run never causes a worktree to be created for it.
                const badGraph = refuseGraph(tasks)
                if (badGraph) {
                  return { output: `ERROR: ${badGraph}`, isError: true }
                }
                // AH-109: tasks whose declared changes overlap go to the
                // person before anything is provisioned or dispatched. Each
                // answer is applied and the graph is looked at again, so a
                // revised scope that still overlaps is asked about too.
                const allowParallel = new Set<string>()
                const overrides: ParallelOverride[] = []
                const decided: string[] = []
                for (let round = 0; ; round += 1) {
                  const open = scopeConflicts(tasks).filter(
                    (c) => !allowParallel.has(conflictKey(c))
                  )
                  if (open.length === 0) break
                  if (round >= 6) {
                    return {
                      output: `ERROR: ${refuseUnresolved(tasks, allowParallel)}`,
                      isError: true,
                    }
                  }
                  const answer = await useTeamConflictRequests
                    .getState()
                    .request(sid, callId, tasks, open, controller.signal)
                  if (answer.kind === 'cancel') {
                    return {
                      output:
                        'ERROR: the user chose not to run these tasks, because ' +
                        `they would change the same paths: ${open
                          .map((c) => `${c.tasks.join(' and ')} on ${c.overlaps.map((o) => o.paths[0]).join(', ')}`)
                          .join('; ')}. Nothing ran.`,
                      isError: true,
                    }
                  }
                  for (const c of open) {
                    const d = answer.decisions[conflictKey(c)]
                    if (!d) continue
                    const where = c.overlaps.map((o) => o.paths[0]).join(', ')
                    if (d.kind === 'parallel') {
                      allowParallel.add(conflictKey(c))
                      overrides.push({
                        tasks: [...c.tasks],
                        paths: c.overlaps.map((o) => o.paths[0]),
                        decidedAt: new Date().toISOString(),
                      })
                      decided.push(
                        `${c.tasks.join(' and ')} ran side by side at the user's decision despite both changing ${where}`
                      )
                    } else if (d.kind === 'serialize') {
                      decided.push(
                        `${d.then} ran after ${d.first}, at the user's decision, because both change ${where}`
                      )
                    } else {
                      decided.push(
                        `the user limited ${d.task} to: ${d.writes.join(', ') || 'nothing'}`
                      )
                    }
                    tasks = applyDecision(tasks, d)
                  }
                  const revised = refuseGraph(tasks)
                  if (revised) {
                    return { output: `ERROR: ${revised}`, isError: true }
                  }
                }
                // Every isolated task gets its checkout before any child
                // starts. A team that could only isolate some of its tasks is
                // refused whole: the alternative is children silently writing
                // the folder the request asked them to stay out of.
                const plan = await planDestinations(tasks, {
                  parentSessionId: sid,
                  project: current?.folder ?? null,
                  // Only asked for when something actually isolates: a team
                  // that wants nothing of its own should not depend on this
                  // answering at all.
                  dataFolder: tasks.some((one) => one.isolate)
                    ? ((await serviceHub
                        .app()
                        .getJanDataFolder()
                        .catch(() => '')) ?? '')
                    : '',
                  canIsolate,
                  ensure: (owner, project, dataFolder) =>
                    useCoworkWorktrees
                      .getState()
                      .ensure(owner, project, dataFolder),
                  authorize: (owner, folderPath, dataFolder) =>
                    useDirectEditGrants
                      .getState()
                      .authorize(owner, folderPath, dataFolder),
                  revoke: (owner) => {
                    useCoworkWorktrees.getState().forget(owner)
                    return useDirectEditGrants.getState().revokeSession(owner)
                  },
                })
                if (!plan.ok) {
                  return { output: `ERROR: ${plan.refusal}`, isError: true }
                }
                // The team is itself a unit of work: without a record of its
                // own, its progress would have nowhere to land and its children
                // would appear in the panel as unrelated errands.
                const teamTaskId = taskIdFor(sid, runId, callId)
                recordAgentDispatch(run, {
                  callId,
                  agentName: 'team',
                  description: `${tasks.length} tasks`,
                  model: selectedModel.id,
                  anchorMessageId: anchorMessageId(),
                })
                useCoworkActivity.getState().patchTask(teamTaskId, {
                  status: 'running',
                  startedAt: Date.now(),
                })
                try {
                  const outcome = await runTeam(tasks, {
                    // The turn's controller: stopping the run stops the team,
                    // and every child hangs off a signal chained to this one.
                    signal: controller.signal,
                    allowParallel,
                    onState: (state: TeamState) =>
                      useCoworkActivity
                        .getState()
                        .patchTask(teamTaskId, { detail: teamProgress(state) }),
                    runTask: async (one: TeamTask, signal: AbortSignal) => {
                      // One call id per task, so each child gets its own
                      // transcript lane and its own entry in the Tasks panel.
                      const childId = `${callId}:${one.id}`
                      const destination = plan.byTask.get(one.id)
                      if (destination) {
                        // Said in the panel, not only in the report: someone
                        // watching a child work needs to know it is not their
                        // folder it is working in.
                        useCoworkActivity
                          .getState()
                          .patchTask(taskIdFor(sid, runId, childId), {
                            detail: `own checkout: ${destination.path}`,
                          })
                        // AH-109: recorded before it runs, so its worktree is
                        // listed for review whatever becomes of the run -- and
                        // an isolated child that cannot be recorded does not
                        // run, rather than leaving work nobody is shown.
                        const began = await beginTeamChild({
                          parentSession: sid,
                          taskId: one.id,
                          run: runId,
                          call: callId,
                          description: one.description,
                          agent: one.subagentName ?? 'worker',
                          project: current?.folder ?? '',
                          declaredWrites: one.writes,
                          overrides: overrides.filter((o) =>
                            o.tasks.includes(one.id)
                          ),
                        })
                        useTeamChildrenVersion.getState().bump()
                        if (!began.ok) {
                          return {
                            taskId: one.id,
                            ok: false,
                            output: `its checkout could not be recorded for review, so it did not run: ${began.reason}`,
                            producedBy: childId,
                          }
                        }
                      }
                      // How the child ended, for its review record: a Stop
                      // from the panel or the run is a cancellation, never a
                      // failure and never a success.
                      const childTask = taskIdFor(sid, runId, childId)
                      const endedAs = (isError: boolean) =>
                        signal.aborted ||
                        useCoworkActivity.getState().tasks[childTask]
                          ?.status === 'cancelled'
                          ? ('cancelled' as const)
                          : isError
                            ? ('failed' as const)
                            : ('completed' as const)
                      let status: 'completed' | 'failed' | 'cancelled' =
                        'failed'
                      let detail = ''
                      try {
                        const result = await dispatchChild(
                          childId,
                          {
                            subagent_name: one.subagentName ?? 'worker',
                            description: one.description,
                            // A task that names no saved agent still has to be
                            // runnable: without a prompt it resolves to nothing
                            // and is refused as unknown, which would make the
                            // ordinary case the one that cannot run. A named
                            // agent ignores this, as `resolveSubagent` prefers
                            // the saved definition.
                            system_prompt: TEAM_DEFAULT_PROMPT,
                          },
                          signal,
                          teamTaskId,
                          destination
                        )
                        status = endedAs(result.isError === true)
                        detail = result.output.slice(0, 500)
                        return {
                          taskId: one.id,
                          ok: status === 'completed',
                          output: result.output,
                          producedBy: childId,
                          // Not authority-bearing, and the one thing that stops a
                          // completed task reading as "changed your folder".
                          ...(destination
                            ? { destination: destination.path }
                            : {}),
                        }
                      } catch (error) {
                        status = endedAs(true)
                        detail =
                          error instanceof Error ? error.message : String(error)
                        throw error
                      } finally {
                        if (destination) {
                          await settleTeamChild(sid, one.id, status, detail).catch(
                            () => {}
                          )
                          useTeamChildrenVersion.getState().bump()
                        }
                      }
                    },
                  })
                  if (!outcome.ok) {
                    useCoworkActivity.getState().patchTask(teamTaskId, {
                      status: 'error',
                      output: outcome.refusal,
                      endedAt: Date.now(),
                    })
                    return {
                      output: `ERROR: ${outcome.refusal}`,
                      isError: true,
                    }
                  }
                  const where = describeDestinations(plan.byTask)
                  const rendered = [
                    renderTeamReport(outcome.report),
                    where
                      ? `${where}\nTheir changes wait for the user's review in the Changes panel; none of them has been applied.`
                      : '',
                    decided.length
                      ? `Decided by the user before the team ran:\n${decided.map((d) => `- ${d}`).join('\n')}`
                      : '',
                  ]
                    .filter(Boolean)
                    .join('\n\n')
                  useCoworkActivity.getState().patchTask(teamTaskId, {
                    // The team's own row settles on what actually happened, so a
                    // partial run cannot read as a finished one at a glance.
                    status: controller.signal.aborted
                      ? ('cancelled' as const)
                      : outcome.report.allDone
                        ? ('done' as const)
                        : ('error' as const),
                    output: rendered,
                    detail: teamProgress(outcome.state),
                    endedAt: Date.now(),
                  })
                  return {
                    output: rendered,
                    // A team where something failed is an error result, so the
                    // agent cannot read a partial run as a finished one.
                    isError: !outcome.report.allDone,
                  }
                } finally {
                  // The children are done, so their authority goes back. The
                  // worktrees stay: they hold the work the team was run for,
                  // and the report names where each one is.
                  await plan.release()
                }
              },
            }, toolSignal),
          sink,
          onStep: ({ step, result, turns, outcomes }) => {
            if (result.usage) setLiveUsage(result.usage)
            // Persisted as it goes, not at the end: a run killed mid-flight
            // must not come back with its steps unspent. AH-018.
            useCoworkSessions.getState().setRunBudget(sid, {
              runId,
              steps: step,
              maxSteps: MAX_AGENT_STEPS,
              deadlineAt: runDeadline.at,
              deadlineBudgetMs: runDeadline.budgetMs,
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
            if (result.usage) {
              void recordPayloadUsage({
                session: sid,
                run: runId,
                snapshot: lastSnapshotRef.current,
                model: selectedModel?.id,
                usage: result.usage,
              })
            }
            // Replace the optimistic running rows with the settled ones so the
            // transcript shows results, not spinners.
            liveTurnsRef.current = liveTurnsRef.current.filter(
              (turn) =>
                !(turn.role === 'tool' && outcomes.has(turn.callId ?? '')) &&
                !(turn.role === 'assistant' && turn.content === result.text)
            )
            pushLive(turns)
            // Record this step's file work now. Ids are keyed on the tool
            // call, so the commit below re-recording the same rows is a
            // no-op rather than a duplicate.
            useFileActivity
              .getState()
              .record(sid, deriveFromTurns(turns, originOfPath, Date.now()))
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
              if (collecting) recordJobCollected(collecting, outcome)
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
          },
          nextMessageId: (() => {
            let n = baseMessages.length
            return () => `${sid}-asst-${n++}`
          })(),
        },
      })
    } catch (e) {
      // The runner turns a failed step into an outcome, so this is the last
      // resort — a fault in the loop itself. Either way it is not a tool call,
      // and rendering it as one claimed the agent had run something.
      thrown = isAbortLike(e, controller.signal)
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
      useAppState.getState().updateLoadingModel(false)
      endRun(sid, runId)
      // The run is over, so its budget is not outstanding any more. Left
      // behind, it would tell the next run it was resuming this one.
      useCoworkSessions.getState().setRunBudget(sid, null)
      // Nothing can still be running once the turn is over: the streams are
      // closed and the dispatch loop has stopped awaiting them. Settle before
      // closing the workflow, so its status is derived from settled children.
      // This run's orphans only — scoped to its own workflow, and leaving a
      // backgrounded shell job alone: the process is still running, and
      // marking it cancelled would be false at the moment it was written and
      // unrepairable afterwards.
      useCoworkActivity.getState().settleRun(runId, INTERRUPTED_BY_RUN_END)
      useCoworkActivity.getState().finishWorkflow(runId)
      useCoworkSessions
        .getState()
        .commitTurns(
          sid,
          liveTurnsRef.current,
          outcome?.messages ?? messages,
          useCoworkRun.getState().subagents[sid] ?? [],
          outcome?.usage ?? undefined
        )
      // The transcript's tool rows are structured: name, arguments, error
      // flag, diff. That is the only thing the file record is built from.
      // A final sweep: anything the steps missed, plus every subagent's own
      // file work, which only exists on the runs themselves.
      const settledAt = Date.now()
      const subagentRuns = useCoworkRun.getState().subagents[sid] ?? []
      const fileEvents = [
        ...deriveFromTurns(liveTurnsRef.current, originOfPath, settledAt),
        ...subagentRuns.flatMap((run) =>
          deriveFromSubagent(run.name, run.turns, originOfPath, settledAt)
        ),
      ]
      useFileActivity.getState().record(sid, fileEvents)
      // The run's own account of what changed, generated from evidence rather
      // than written by the model that did the changing.
      void recordOrigins({ sessionId: sid, origins, events: fileEvents })
      liveTurnsRef.current = []
      setLiveTurns([])
      setRunning(false)
      runWorkDone()
      abortRef.current = null
      askResolvers.current.clear()
      setStoppedBy(thrown?.stoppedBy ?? outcome?.stoppedBy ?? null)
      setRunError(thrown?.errorText ?? outcome?.errorText)
      recordEvents([
        {
          id: `run:${runId}:ended`,
          session: sid,
          run: runId,
          kind: 'run.ended',
          payload: {
            stoppedBy: thrown?.stoppedBy ?? outcome?.stoppedBy ?? 'unknown',
            detail: thrown?.errorText ?? outcome?.errorText ?? '',
          },
        },
      ])
    }
  }

  // Read through a ref so the memoized message rows keep a stable callback
  // while still calling the current render's closure.
  const runRequestRef = useRef(runRequest)
  runRequestRef.current = runRequest

  const handleSubmit = (text: string) => void runRequest(text)

  /**
   * Take the last turn again. Rewinding to the question and resuming is the
   * whole operation — an agent turn is a chain of tool calls, so regenerating
   * means discarding that chain, not re-sending the question after it.
   */
  const handleRegenerate = useCallback(() => {
    if (running || !session?.id) return
    useCoworkSessions.getState().rewindToLastUser(session.id)
    void runRequestRef.current(null)
  }, [running, session?.id])

  const abortRef = useRef<AbortController | null>(null)
  const askResolvers = useRef(
    new Map<string, (answers: AskAnswer[] | null) => void>()
  )

  const handleStop = useCallback(() => {
    abortRef.current?.abort('cancelled')
    if (session?.id) abortRun(session.id)
    for (const resolve of askResolvers.current.values()) resolve(null)
    askResolvers.current.clear()
  }, [session?.id])

  const respondAsk = useCallback(
    (requestId: string, answers: AskAnswer[] | null) => {
      const resolve = askResolvers.current.get(requestId)
      askResolvers.current.delete(requestId)
      if (resolve) resolve(answers)
      else if (session?.id) answerAsk(session.id, requestId, answers)
    },
    [session?.id]
  )

  /**
   * Where the transcript was scrolled to, kept across a trip to Settings.
   *
   * The scroll node is the one `StickToBottom` owns inside the `role="log"`
   * container; it is found rather than held by ref because that element is the
   * library's, not this route's.
   */
  const scrollNode = useCallback((): HTMLElement | null => {
    const log = document.querySelector('[role="log"]')
    if (!log) return null
    return (
      (log.querySelector(':scope > *') as HTMLElement | null) ??
      (log as HTMLElement)
    )
  }, [])

  useEffect(() => {
    const sid = session?.id
    if (!sid) return
    const remembered = useCoworkView.getState().scrollBySession[sid]
    if (remembered != null) {
      // After paint: the transcript has to exist before it can be scrolled.
      requestAnimationFrame(() => {
        const node = scrollNode()
        if (node) node.scrollTop = remembered
      })
    }
    return () => {
      const node = scrollNode()
      if (node) {
        useCoworkView.getState().rememberScroll(sid, node.scrollTop)
      }
    }
  }, [session?.id, scrollNode])

  // Snapshots are taken in the transport, which has nowhere to return them to
  // -- the AI SDK owns the call. It hands them here instead, and they land on
  // the turn whose reply that request produced.
  useEffect(() => {
    setSnapshotSink((sessionId, ref) => {
      // Kept for the step that follows: the accounting for a dispatch is only
      // known once its reply lands, and by then the sink has moved on.
      lastSnapshotRef.current = ref
      // Beside the turns, not on them: the run rebuilds its live turn array as
      // steps complete, so a reference written onto a turn at dispatch time is
      // gone before it can render.
      useCoworkRun.getState().recordPromptSnapshot(sessionId, ref)
    })
    return () => setSnapshotSink(null)
  }, [])

  // A run outlives this component, so unmounting must not stop it.
  useEffect(() => () => useCoworkRun.getState().clearPendingPreview(), [])

  // The artifacts library selects a session, parks the path here and navigates.
  // Consumed once, so returning to Cowork later does not reopen it.
  const pendingPreview = useCoworkRun((s) => s.pendingPreview)
  useEffect(() => {
    if (!pendingPreview || !session?.id) return
    if (pendingPreview.sessionId !== session.id) return
    setLastPreviewPath(pendingPreview.path)
    setRail({ kind: 'preview', path: pendingPreview.path })
    useCoworkRun.getState().clearPendingPreview()
  }, [pendingPreview, session?.id])

  // The file-activity view parks a request the same way, for a path it wants
  // shown but cannot open itself. Consumed once.
  // An entry point outside Cowork asked for a folder. The picker lives here
  // because this is where a session can be bound to what it returns.
  const attachFolderRequested = useCoworkRun((s) => s.attachFolderRequested)
  useEffect(() => {
    if (!attachFolderRequested) return
    // Cleared before the picker opens, not after: the dialog is awaited, and a
    // request left standing would reopen it on the next render.
    useCoworkRun.getState().clearAttachFolderRequest()
    void attachFolder()
  }, [attachFolderRequested, attachFolder])

  const pendingCodeOpen = useCoworkRun((s) => s.pendingCodeOpen)
  useEffect(() => {
    if (!pendingCodeOpen || !session?.id) return
    if (pendingCodeOpen.sessionId !== session.id) return
    if (pendingCodeOpen.as === 'diff') {
      setRail({ kind: 'diff' })
    } else {
      setRail({ kind: 'code' })
      openToolPath(pendingCodeOpen.path)
    }
    useCoworkRun.getState().clearPendingCodeOpen()
  }, [pendingCodeOpen, session?.id, openToolPath])

  // Nothing to show once the session changes: every panel describes the session
  // it was opened from.
  //
  // Only a real switch closes the rail. Opening the Code or Activity rail with
  // no session yet *creates* one (ensureCurrentSession), which moved
  // `session?.id` from null to a fresh id in the same commit — and this effect
  // then closed the rail the click had just opened, so the first click did
  // nothing and only a second one worked.
  const lastSessionId = useRef(session?.id)
  useEffect(() => {
    const previous = lastSessionId.current
    lastSessionId.current = session?.id
    if (previous != null && previous !== session?.id) setRail(null)
  }, [session?.id])

  return (
    <div className="flex flex-col h-[calc(100dvh-(env(safe-area-inset-bottom)+env(safe-area-inset-top)))]">
      <HeaderPage>
        {/* The same row component the chat page uses, so the selector and the
            control beside it match in size, spacing and order. */}
        <PageHeaderRow>
          <DropdownModelProvider useLastUsedModel />
          {/* Everything about the session that is reference material rather
              than conversation, closed until asked for. */}
          <CoworkSessionDetails summary={sessionDetailsSummary}>
            <CoworkReadinessCard manifest={readiness} />
            {/* AH-177: this session's canonical events, written to a file. */}
            <CoworkEventExport
              sessionId={session?.id}
              pickFolder={async () => {
                const picked = await serviceHub.dialog().open({ directory: true })
                return typeof picked === 'string' ? picked : null
              }}
            />
            {/* Collapsed, and inside session details rather than above the
                composer: someone whose session works should never read it. */}
            <CoworkEnvironmentReadiness projectRoot={folder ?? undefined} />
            {runContext && <CoworkContextBreakdown context={runContext} />}
            <CoworkCompatSection
              manifest={compat}
              hasFolder={Boolean(folder)}
              onToggle={(on) =>
                folder && useClaudeCompat.getState().setEnabled(folder, on)
              }
              // Drives Jan's own MCP subsystem, against the definition as it
              // stands on disk: consent is permission to run *this* server,
              // not whatever the file says later.
              onMcpConsent={(server, allowed) => {
                const probe = mcpProbes.find((one) => one.name === server)
                if (probe) void setMcpConsent(probe, allowed)
              }}
            />
            <ClaudeSkillRootsSettings
              roots={skillRoots}
              onChange={(next) =>
                useClaudeCompat.getState().setSkillRoots(next)
              }
              janData={janDataFolder}
              onRescan={rescanCompat}
              pickFolder={async () => {
                const picked = await serviceHub
                  .dialog()
                  .open({ directory: true })
                return typeof picked === 'string' ? picked : null
              }}
              // The backend is the only thing that can tell a directory from a
              // file, or from a path that has since gone.
              confirmDirectory={async (path) => {
                const dataFolder = janDataFolder
                if (!dataFolder) return false
                try {
                  await projectListDir(dataFolder, path, '.')
                  return true
                } catch {
                  return false
                }
              }}
            />
          </CoworkSessionDetails>
        </PageHeaderRow>
      </HeaderPage>

      <div className="flex flex-1 h-full overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col h-full overflow-hidden">
          <div className="flex-1 relative">
            {displayedTurns.length === 0 ? (
              <CoworkEmptyState
                folder={folder}
                onPick={(text) => usePrompt.getState().setPrompt(text)}
              />
            ) : (
              <Conversation className="absolute inset-0 text-start">
                <ConversationContent
                  className={cn('mx-auto w-full md:w-4/5 xl:w-4/6')}
                >
                  <CodeOpenProvider open={openToolPath}>
                    {uiMessages.map((message, i) => (
                      <Fragment key={message.id}>
                        <MessageItem
                          message={message}
                          isFirstMessage={i === 0}
                          isLastMessage={i === uiMessages.length - 1}
                          status={running ? 'streaming' : 'ready'}
                          onRegenerate={handleRegenerate}
                          reasoningContainerRef={reasoningContainerRef}
                          isReasoningAtBottom={isReasoningAtBottom}
                          onReasoningScroll={handleReasoningScroll}
                          onReasoningScrollToBottom={
                            forceScrollReasoningToBottom
                          }
                          // The tool calls are the work here, not scaffolding
                          // behind an answer: they stay in the conversation
                          // unless the display option hides the finished ones.
                          keepToolActivity
                        />
                        {/* One card per workflow, at the message its first
                        dispatch landed under. Same store as the panel, so it
                        is live without a copy of anything. */}
                        {(() => {
                          const view = workflowAnchoredAt(
                            activity,
                            session?.id,
                            message.id
                          )
                          return view ? (
                            <CoworkWorkflowCard
                              view={view}
                              now={activityNow}
                              onOpenTask={showTaskInPanel}
                              onOpenPanel={showWorkflowInPanel}
                            />
                          ) : null
                        })()}
                        {/* Completed tool activity the display option is
                        filtering out. The turns are still in the session; this
                        says how many and offers to look. */}
                        {(() => {
                          const part = (
                            message.parts as { type: string; data?: unknown }[]
                          ).find((p) => p.type === 'data-hidden-tools')
                          const data = part?.data as
                            | { count: number }
                            | undefined
                          return data ? (
                            <CoworkHiddenTools
                              count={data.count}
                              onReveal={() => setRevealHiddenTools(true)}
                            />
                          ) : null
                        })()}
                        {/* Questions the run asked here, in the order they
                        were asked. A pending one is the card; an answered,
                        skipped or stale one collapses to what happened, and
                        stays in the transcript. */}
                        {(message.parts as { type: string; data?: unknown }[])
                          .filter((p) => p.type === 'data-ask')
                          .map((p) => {
                            const record = p.data as AskRecord
                            return (
                              <CoworkAskEntry
                                key={record.requestId}
                                record={record}
                                running={running}
                                onRespond={respondAsk}
                              />
                            )
                          })}
                        {/* What the model received, at the message it
                        produced. Collapsed, and it fetches nothing until
                        someone opens it. */}
                        {(() => {
                          // AH-078. The message's own part first: it was
                          // stamped onto the assistant row when that row was
                          // created, so it names the dispatch that produced
                          // this reply -- including a continuation, a retry or
                          // a compaction, which position cannot distinguish.
                          //
                          // The positional map stays as the fallback for turns
                          // already on disk, written before rows carried one.
                          const own = (
                            message.parts as { type: string; data?: unknown }[]
                          ).find((part) => part.type === 'data-prompt-snapshot')
                            ?.data as { id: string } | undefined
                          const ref = own ?? snapshotByMessageId.get(message.id)
                          return ref ? (
                            <PromptSnapshotView
                              snapshotId={ref.id}
                              sessionId={session?.id}
                            />
                          ) : null
                        })()}
                        {/* Derived from the message's own write parts, so nothing
                        shared with the chat surface needs to know artifacts
                        exist. */}
                        {artifactsFromParts(message.parts).map((artifact) => (
                          <CoworkArtifactCard
                            key={artifact.path}
                            artifact={artifact}
                            root={workspacePath}
                            onPreview={showPreview}
                          />
                        ))}
                      </Fragment>
                    ))}
                  </CodeOpenProvider>
                  {/* AH-109: overlapping team tasks, before either runs. */}
                  <CoworkTeamConflicts sessionId={session?.id} />
                  <CoworkChildApprovals sessionId={session?.id} />
                  {running && (
                    // Row wrapper as in the chat route: the transcript is a
                    // column flex, which stretches the indicator's own
                    // `inline-flex` box across the whole column.
                    <div className="flex flex-row items-center gap-2">
                      <PromptProgress
                        hideIdle={!awaitingModel}
                        stateKey={session?.id}
                      />
                    </div>
                  )}
                  {!running &&
                    runOrigins?.summary &&
                    // Only when this run actually wrote something. A working
                    // tree that was already dirty is not the run's work, and
                    // reporting it here left a permanent panel over the
                    // composer listing the user's own edits.
                    hasJanAuthoredChanges(runOrigins.summary) && (
                      <CoworkRunSummary summary={runOrigins.summary} />
                    )}
                  {stoppedBy === 'steps' && (
                    <CoworkBudgetNotice
                      kind="steps"
                      max={MAX_AGENT_STEPS}
                      onContinue={() => void handleSubmit('Continue.')}
                    />
                  )}
                  {stoppedBy === 'aborted' && (
                    <CoworkRunNotice kind="stopped" />
                  )}
                  {stoppedBy === 'error' && (
                    <CoworkRunNotice
                      kind="error"
                      message={runError}
                      onRetry={() => void runRequest(null)}
                    />
                  )}
                  {(stoppedBy === 'deadline' ||
                    stoppedBy === 'timeout' ||
                    stoppedBy === 'loop') && (
                    <CoworkRunNotice
                      kind={stoppedBy}
                      message={runError}
                      onRetry={() => void runRequest(null)}
                    />
                  )}
                  {stoppedBy === 'tokens' && (
                    <CoworkBudgetNotice
                      kind="tokens"
                      onCompact={() => toast.info(t('common:budget.compact'))}
                      onNewSession={() => {
                        // Same rule as the sidebar's entry point: one press,
                        // at most one session.
                        const store = useCoworkSessions.getState()
                        const id = store.startSession({
                          running,
                          hasDraft:
                            usePrompt.getState().prompt.trim().length > 0,
                        })
                        store.selectSession(id)
                      }}
                    />
                  )}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>
            )}
          </div>

          <div className="pb-4 shrink-0">
            <div className="mx-auto w-full md:w-4/5 xl:w-4/6">
              {/* Work a crashed or closed run left behind. Shown where the
                  session is about to start, because that is the moment someone
                  would otherwise start a second one beside it. Everything else
                  that used to sit here -- readiness, compatibility, skill
                  folders, context accounting -- moved behind the session
                  details control in the header, so the composer sits directly
                  beneath the conversation. */}
              {folder && (session?.turns.length ?? 0) === 0 && (
                <div className="px-1 pb-2">
                  <CoworkWorktreeRecovery
                    orphans={orphanWorktrees(foundWorktrees, worktree)}
                    onAdopt={(record) => {
                      if (session?.id)
                        useCoworkWorktrees.getState().adopt(session.id, record)
                    }}
                    onPending={(record) =>
                      useCoworkWorktrees.getState().pending(record)
                    }
                    onRemove={async (record, force) => {
                      const dataFolder = await serviceHub
                        .app()
                        .getJanDataFolder()
                      if (!dataFolder) return
                      // Removed under a temporary binding rather than through
                      // the session's own record: this checkout belongs to no
                      // session, and adopting it first to delete it would put
                      // the session on a worktree that is about to be gone.
                      const key = `recovery:${record.path}`
                      useCoworkWorktrees.getState().adopt(key, record)
                      const done = await useCoworkWorktrees
                        .getState()
                        .discard(key, dataFolder, force)
                      useCoworkWorktrees.getState().forget(key)
                      if (!done.ok) toast.error(done.reason)
                      setFoundWorktrees(
                        await useCoworkWorktrees
                          .getState()
                          .list(folder, dataFolder)
                      )
                    }}
                  />
                </div>
              )}
              {/* AH-210: what a handed-off session could not bring with it. */}
              <CoworkHandoffNotice
                handoff={session?.handoff}
                folder={folder}
                onDismiss={() =>
                  session &&
                  useCoworkSessions.getState().dismissHandoff(session.id)
                }
              />
              {/* AH-209: a folder with no JAN.md is offered a starting one,
                  proposed from a survey and written only when accepted. */}
              <CoworkProjectInit
                folder={treeRoot ?? null}
                // Offered only when JAN.md is known to be absent; one that
                // could not be read is still there, and is not overwritten.
                hasInstructions={
                  !instructionFiles.some(
                    (file) =>
                      file.role === 'native' && file.state.kind === 'missing'
                  )
                }
                onAccepted={() => setInstructionsVersion((v) => v + 1)}
              />
              <ChatInput
                showSpeedToken={false}
                initialMessage={true}
                scopeKey={session?.id}
                ownsToolSet={false}
                // `@` names files in the folder the run works in, nothing else.
                referenceRoot={treeRoot}
                referenceSources={referenceSources}
                onSubmit={handleSubmit}
                onStop={handleStop}
                chatStatus={running ? 'streaming' : 'ready'}
                // One stop control for this surface, in the composer's own
                // action slot: it asks how far to stop rather than sitting
                // beside a second, destructive button.
                stopControl={
                  <CoworkStopMenu
                    running={running}
                    sessionId={session?.id}
                    runId={session?.id}
                    onStopCurrent={handleStop}
                  />
                }
                tokenSource={tokenSource}
                surfaceControls={
                  <>
                    <CoworkModeSelector
                      mode={mode}
                      onChange={(next) => {
                        if (session?.id)
                          useCoworkSessions.getState().setMode(session.id, next)
                      }}
                    />
                    <CoworkAccessSelector
                      effective={effective}
                      capability={capabilityState}
                      hasFolder={Boolean(folder)}
                      // Authority must not move under work already running.
                      // A background shell job outlives its run and can still
                      // write, so it holds authority in place just as a live
                      // turn does.
                      busyReason={blockingKind}
                      onRequestDirectEdit={() => setConfirmDirectEdit(true)}
                      onRequestWorktree={() => void authorizeManagedWorktree()}
                      onReviewOnly={() => void returnToReviewOnly()}
                    />
                    <CoworkWorkspacePill
                      folder={folder}
                      workspacePath={workspacePath}
                      gitBranch={gitBranch}
                      onAttach={() => void attachFolder()}
                      onDetach={detachFolder}
                    />
                    <CoworkSandboxChip />
                    <CoworkRailToolbar
                      active={activeRail}
                      onSelect={selectRail}
                      changeCount={changeCounts.fileCount}
                      additions={changeCounts.additions}
                      deletions={changeCounts.deletions}
                      changeSummary={formatChangeSummary(changeCounts)}
                      activity={taskCounts}
                    />
                    <div className="ml-auto flex items-center">
                      <SkillSelector folder={folder} />
                    </div>
                  </>
                }
              />
            </div>
          </div>
        </div>

        {rail?.kind === 'preview' && (
          <CoworkPreviewPanel
            root={workspacePath}
            path={rail.path}
            onClose={() => setRail(null)}
          />
        )}
        {rail?.kind === 'diff' && (
          <CoworkDiffPanel
            // Going back to how things were belongs where what changed is
            // shown: the two questions are asked in the same breath.
            header={
              <>
              {/* An isolated run's work reaches the folder only through a
                  reviewed proposal, so the review sits with the changes. */}
              {worktree && session?.id ? (
                <CoworkProposalReview
                  worktree={worktree}
                  session={session.id}
                  onApplied={() => git.refresh()}
                />
              ) : null}
              {/* AH-109: each isolated team child's worktree, for review. */}
              {folder && session?.id ? (
                <CoworkTeamReviews
                  project={folder}
                  session={session.id}
                  onApplied={() => git.refresh()}
                />
              ) : null}
              {/* AH-169: a patch bundle exported elsewhere, reviewed here. */}
              {folder && session?.id ? (
                <CoworkBundleImport
                  destination={folder}
                  session={session.id}
                  pickFolder={async () => {
                    const picked = await serviceHub
                      .dialog()
                      .open({ directory: true })
                    return typeof picked === 'string' ? picked : null
                  }}
                  onApplied={() => git.refresh()}
                />
              ) : null}
              {/* AH-202: each turn's own file changes, undone or redone
                  from the turn that made them. */}
              {session?.id ? (
                <CoworkTurnUndo
                  sessionId={session.id}
                  writeGrant={liveGrant?.grantId}
                  refreshKey={running}
                  onChanged={() => git.refresh()}
                />
              ) : null}
              <CoworkRewind
                points={
                  session?.id
                    ? useCoworkCheckpoints
                        .getState()
                        .usable(session.id, treeRoot)
                    : []
                }
                onPlan={(sha) =>
                  useCoworkCheckpoints.getState().plan(session?.id ?? '', sha)
                }
                onRestore={async (sha) => {
                  const done = await useCoworkCheckpoints
                    .getState()
                    .restore(session?.id ?? '', sha)
                  // The tree changed underneath every surface that describes
                  // it, so the diff is re-read rather than left showing what
                  // was there a moment ago.
                  if (done.ok) git.refresh()
                  return done
                }}
              />
              </>
            }
            sandboxFiles={fileDiffs}
            onOpenFile={openToolPath}
            // The tree the changes are in, not the one the session is
            // attached to: a managed run's diff lives in its worktree.
            folder={treeRoot}
            git={git}
            origins={runOrigins?.entries}
            onClose={() => setRail(null)}
          />
        )}
        {rail?.kind === 'tasks' && (
          <CoworkTasksPanel
            workflows={workflowViews}
            totals={taskCounts}
            focusWorkflowId={focusWorkflowId}
            focusTaskId={focusTaskId}
            onFocusHandled={() => {
              setFocusTaskId(null)
              setFocusWorkflowId(null)
            }}
            agentReachable={agentReachable}
            onCancelTask={cancelTask}
            onCancelWorkflow={cancelWorkflowTasks}
            onClearFinished={() => {
              if (session?.id) {
                useCoworkActivity.getState().clearFinished(session.id)
              }
            }}
            onClose={() => setRail(null)}
          />
        )}
        {rail?.kind === 'code' && session?.id && (
          <CoworkCodePanel
            onOfferFolder={() => void attachFolder()}
            // The tree the run reads. Browsing the attached folder while the
            // agent works in a worktree would show two different repositories
            // under one name.
            folder={treeRoot}
            workspacePath={workspacePath}
            sessionKey={session.id}
            state={session.codePanel}
            turns={displayedTurns}
            onStateChange={(next) =>
              useCoworkSessions.getState().setCodePanel(session.id, next)
            }
            onAddToChat={addCodeToChat}
            onAttach={() => void attachFolder()}
            onClose={() => setRail(null)}
          />
        )}
      </div>
      {/* Mounted outside the panels so it survives a rail change while the
          authorization is in flight. */}
      <DirectEditConfirmDialog
        open={confirmDirectEdit}
        facts={directEditFacts}
        onConfirm={authorizeDirectEdit}
        onCancel={() => setConfirmDirectEdit(false)}
      />
    </div>
  )
}
