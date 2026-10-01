/* eslint-disable @typescript-eslint/no-explicit-any */
import { promptReplaceModels } from '@/hooks/useModelReplacePrompt'
import { modelKey, unavailableModels } from '@/lib/modelReplace'
import { switchedFromOf } from '@/lib/assistantSwitch'
import { messageWeight, transcriptWindowStart } from '@/lib/transcriptWindow'
import { markConversationOpened } from '@/lib/messageEntry'
import { PrBar } from '@/containers/PrBar'
import { useRemoteComposer } from '@/lib/remote/composer'
import { ModelDoctor } from '@/containers/ModelDoctor'
import { JevSkillSuggestion } from '@/containers/JevSkillSuggestion'
import { BrowserVerifyPanel } from '@/containers/BrowserVerifyPanel'
import { useBrowserVerify } from '@/hooks/useBrowserVerify'
import type { VerifyReport } from '@/lib/browserVerify'
import { currentDoctorResult, observedToolsFact, useModelDoctor } from '@/hooks/useModelDoctor'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { parseSlashMarker, slashDisplay } from '@/lib/slashCommands'
import ChatInput from '@/containers/ChatInput'
import { CodeOpenProvider } from '@/containers/message/CodeOpenProvider'
import type { CodeOpenOptions, CodePathCheck } from '@/lib/codeOpen'
import { resolveCodePath } from '@/lib/codePathResolve'
import HeaderPage from '@/containers/HeaderPage'
import {
  CoworkSplitWorkspace,
  SplitToggleButton,
} from '@/containers/SplitConversation'
import {
  ACTIVE_PANE_RING,
  useCoworkPane,
  usePaneChrome,
  usePaneWidth,
} from '@/hooks/useCoworkPane'
import { PaneHeaderBar } from '@/containers/PaneHeaderBar'
import { useLiveJobs } from '@/lib/coworkJobsPoller'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { route } from '@/constants/routes'
import { ensureCoworkEnabled } from '@/lib/coworkGate'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'
import { invoke } from '@tauri-apps/api/core'
import { getLoadedModels } from '@janhq/tauri-plugin-llamacpp-api'
import {
  finishRunResources,
  projectListDir,
  projectReadFile,
} from '@janhq/tauri-plugin-agent-tools-api'
import { cn } from '@/lib/utils'
import {
  ArrowLeft,
  Info,
  Loader2,
  MessageSquare,
  PanelRight,
} from 'lucide-react'
import { basenameOf } from '@/lib/coworkPreview'
import { Frame, FrameBody } from '@/components/ui/frame'
import { Chip } from '@/components/ui/chip'
import { Button } from '@/components/ui/button'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import {
  CoworkInspectorFrame,
  CoworkInspectorProvider,
  CoworkSidePanel,
  type InspectorLayout,
} from '@/containers/CoworkSidePanel'
import { CoworkReviewReady } from '@/containers/CoworkReviewReady'
import {
  useCoworkSessions,
  ensureCurrentSession,
  startPaneSession,
  startPaneSessionParked,
} from '@/hooks/useCoworkSessions'
import { useSessionWorkspacePath } from '@/hooks/useSessionWorkspacePath'
import { useSplitConversation } from '@/hooks/useSplitConversation'
import { resolveCoworkModel } from '@/lib/coworkModelChoice'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import {
  runTitle,
  recordAgentDispatch,
  recordJobCollected,
  recordShellDispatch,
  recordShellOutcome,
  type RunContext,
} from '@/lib/coworkActivityRecorder'
import {
  collectedJobId,
  commandOf,
  countToolCalls,
  finishedJobPatch,
} from '@/lib/coworkTasks'
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
import {
  useMessageQueue,
  type QueuedMessageSender,
} from '@/stores/message-queue-store'
import {
  agentAttribution,
  drainIdleSession,
  takeClaimed,
  hasLiveSteering,
} from '@/lib/mailboxDelivery'
import { PageHeaderRow } from '@/containers/PageHeaderRow'
import { useModelProvider } from '@/hooks/useModelProvider'
import { parseServerContextLimit, rememberServerLimit } from '@/lib/contextLimitRecovery'
import { selectionForThreadModel } from '@/hooks/useConversationPane'
import { MessageItem } from '@/containers/MessageItem'
import SkillSelector from '@/containers/SkillSelector'
import {
  appendLiveMessages,
  assistantAnchorId,
  segmentAssistantMessage,
  workflowSegmentIndex,
  coworkTurnsToUIMessages,
} from '@/lib/coworkTurns'
import { reconcileToolActivity } from '@/lib/coworkActivityTimeline'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'
import { useAssistant } from '@/hooks/useAssistant'
import {
  ContextOverflowError,
  coworkWindow,
  isContextOverflow,
  planTurn,
} from '@/lib/coworkBudget'
import { restoreDeadline, startDeadline } from '@/lib/runDeadline'
import { accountedTotal } from '@/lib/coworkReadiness'
import {
  formatChangeSummary,
  janAuthoredChanges,
} from '@/lib/coworkChangeSummary'
import {
  loadToolActivity,
  recordLifecycle,
  recordToolActivity,
  type ToolActivityItem,
} from '@/lib/toolActivity'
import { createFrameBatch } from '@/lib/frameBatch'
import {
  useToolCallRuntime,
  withToolTiming,
} from '@/hooks/useToolCallRuntime'
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
import { CoworkPlanStrip } from '@/containers/CoworkPlanStrip'
import {
  CoworkPinnedProgress,
  CoworkProgressButton,
} from '@/containers/CoworkPinnedProgress'
import { CoworkHiddenTools } from '@/containers/CoworkHiddenTools'
import {
  useCoworkDisplay,
  useShowPromptSnapshot,
} from '@/hooks/useCoworkDisplay'
import type { AskRecord } from '@/types/coworkSession'
import { CoworkSessionDetails } from '@/containers/CoworkSessionDetails'
import { CoworkEnvironmentReadiness } from '@/containers/CoworkEnvironmentReadiness'
import { rendererReadinessReports } from '@/lib/coworkRendererReadiness'
import { usePrompt } from '@/hooks/usePrompt'
import { addSnapshotSink, type PromptSnapshotRef } from '@/lib/providerFetch'
import { recordPayloadUsage } from '@/lib/payloadUsage'
import { fromCoworkUsage, summarizeUsage } from '@/lib/tokenUsage'
import { speedStats } from '@/lib/tokenSpeed'
import {
  prepareCoworkAttachments,
  type CoworkAttachmentInput,
  type SubmittedFile,
} from '@/lib/coworkAttachments'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { usageEventPayload } from '@/lib/executionTimeline'
import { TurnUsageDetails } from '@/components/TurnUsageDetails'
import { recordMemoryUses } from '@/lib/memoryUses'
import type { TurnMemory } from '@/types/coworkSession'
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
import {
  applySandboxFile,
  applySandboxHunk,
  isFlintInternalPath,
  planSandboxApply,
  sandboxCopyOfProjectFile,
  sandboxRelativePath,
} from '@/lib/coworkSandboxApply'
import { probeSandboxFile } from '@/lib/coworkApplyAll'
import { absoluteChangePath, shortToolPath } from '@/lib/codePathResolve'
import type { SandboxApplyActions } from '@/containers/CoworkApplyAllDialog'
import { CoworkRewind } from '@/containers/CoworkRewind'
import { CoworkCodePanel } from '@/containers/CoworkCodePanel'
import {
  NO_USER_EDITS,
  useCoworkUserEdits,
} from '@/hooks/useCoworkUserEdits'
import { withUserEditNotice } from '@/lib/coworkCodeEdit'
import { CoworkTasksPanel } from '@/containers/CoworkTasksPanel'
import { CoworkTimelinePanel } from '@/containers/CoworkTimelinePanel'
import type { LiveJob } from '@/lib/coworkTasks'
import {
  codeRefToken,
  emptyCodePanelState,
  expandCodeRefs,
  artifactTab,
  openTabAt,
  projectKeyOf,
  projectTab,
  sandboxTab,
  shouldOpenInCode,
  relativeToRoot,
  type CodeRef,
  type CodeTab,
} from '@/lib/coworkCode'
import { extraFoldersOf, isInsideAnyFolder } from '@/lib/coworkFolders'
import {
  CoworkRailToolbar,
  type RailMode,
} from '@/containers/CoworkRailToolbar'
import { useCoworkGitStatus } from '@/hooks/useCoworkGitStatus'
import { collectCodeFileDiffs } from '@/lib/coworkDiffs'
import { CoworkSandboxChip } from '@/containers/CoworkSandboxChip'
import { CoworkBudgetNotice } from '@/containers/CoworkBudgetNotice'
import { CompactingIndicator, CompactionDivider } from '@/containers/CompactionDivider'
import type { UIMessage } from 'ai'
import {
  compactHistory,
  compactionWindow,
  resolveAutoCompact,
  shouldCompact,
  DEFAULT_KEEP_RECENT,
  type CompactionRecord,
} from '@/lib/compaction'
import { modelSummarizer } from '@/lib/compactionSummarizer'
import {
  getCompactionPolicy,
  DEFAULT_COMPACTION_POLICY,
  type CompactionPolicy,
} from '@/lib/compactionPolicy'
import { CoworkRunSummary } from '@/containers/CoworkRunSummary'
import { janAuthoredPaths } from '@/lib/coworkOrigins'
import {
  continueRequest,
  deriveRunOutcome,
  shouldShowRunOutcome,
} from '@/lib/coworkRunOutcome'
import { CoworkRunNotice } from '@/containers/CoworkRunNotice'
import { CoworkAskEntry } from '@/containers/CoworkAskEntry'
import { SessionStopNotice } from '@/containers/SessionStopNotice'
import type { SessionStopNotice as SessionStopNoticeData } from '@/types/coworkSession'
import { CoworkContextBreakdown } from '@/containers/CoworkContextBreakdown'
import { CoworkReadinessCard } from '@/containers/CoworkReadinessCard'
import { CoworkProjectInit } from '@/containers/CoworkProjectInit'
import { projectInitLabel, useProjectInitDrafts } from '@/lib/projectInit'
import { CoworkHandoffNotice } from '@/containers/CoworkHandoffNotice'
import { CoworkHeldInput } from '@/containers/CoworkHeldInput'
import { holdQueueThenStop } from '@/lib/chatSteering'
import { CoworkInterruptedTurn } from '@/containers/CoworkInterruptedTurn'
import {
  COWORK_DECISION_WINDOW_MS,
  TeamControl,
  awaitingDecision,
} from '@/lib/coworkTeamControl'
import { useTeamControls } from '@/hooks/useTeamControls'
import { checkpoint as inFlightCheckpoint, checkpointDue } from '@/lib/coworkInflight'
import { CoworkWorktreeRecovery } from '@/containers/CoworkWorktreeRecovery'
import { useShallow } from 'zustand/react/shallow'
import {
  hideRecovery,
  recoverableWorktrees,
  recoveryHidden,
  sessionWorktreeBranch,
} from '@/lib/coworkWorktrees'
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
import {
  accessOf,
  effectiveAccess,
  effectiveDowngradeKey,
  runCarries,
  type AccessMode,
} from '@/lib/coworkAccess'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import {
  COMPATIBILITY_INSTRUCTION_FILES,
  LEGACY_NATIVE_INSTRUCTION_FILE,
  MAX_INSTRUCTION_BYTES,
  NATIVE_INSTRUCTION_FILE,
  bindingKey,
  classifyInstruction,
  isMissingFileError,
  parseSkillRequests,
  parseSkillRequestTriggers,
  resolveSkills,
  unresolvedSkills,
  type ContextAccounting,
  type InstructionFile,
  type InstructionProbe,
  type ReadinessManifest,
} from '@/lib/coworkReadiness'
import { measureContextPack } from '@/lib/coworkContext'
import { coworkPreRunContext } from '@/lib/coworkPreRun'
import { peekAgentToolSchemas } from '@/lib/agentTools'
import {
  CONTINUE_QUESTION_ID,
  decideOpening,
  acceptsProposal,
  continuationInstruction,
  PROPOSAL_ACCEPTED_RESULT,
  recordFor,
} from '@/lib/coworkContinuity'
import { CoworkChatTransport } from '@/lib/coworkTransport'
import { CoworkProposalReview } from '@/containers/CoworkProposalReview'
import { CoworkTurnUndo } from '@/containers/CoworkTurnUndo'
import {
  useCoworkWorktrees,
  type WorktreeRecord,
} from '@/hooks/useCoworkWorktrees'
import { DEFAULT_SESSION_TITLE } from '@/lib/coworkSessionStart'
import { useAutoSessionWorktree } from '@/hooks/useAutoSessionWorktree'
import { useCoworkParallel } from '@/hooks/useCoworkParallel'
import { CoworkSessionWorktreeBar } from '@/containers/CoworkSessionWorktreeBar'
import {
  applyDecision,
  conflictKey,
  parseTeamRequest,
  refuseGraph,
  refuseUnresolved,
  renderTeamReport,
  renderNotRetried,
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
  planExecuteNotice,
  PLAN_EXECUTE_INSTRUCTION,
} from '@/lib/coworkPlanReview'
import {
  getSandboxStatus,
  getSandboxToolchains,
  sandboxEnforces,
} from '@/lib/agentTools'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { MAX_AGENT_STEPS } from '@/lib/coworkBudget'
import {
  abortRun,
  abortAll,
  beginRun,
  endRun,
  hasSubagent,
  registerSubagent,
  unregisterSubagent,
  isAbortLike,
  answerAsk,
  runTurn,
  untilStopped,
  type RunOutcome,
  type StreamSink,
  type ToolOutcome,
} from '@/lib/coworkRunner'
import { useCoworkRun, type RunEnding } from '@/hooks/useCoworkRun'
import { notifyAnswerFinished } from '@/lib/completionSound'
import {
  listSubagents,
  type SubagentDefinition,
} from '@/lib/coworkSubagentRegistry'
import {
  parseSubagentRequest,
  resolveSubagent,
  subagentActorId,
  parentToolNames,
  runSubagent,
  type SubagentRequest,
} from '@/lib/coworkSubagent'
import { errorText } from '@/lib/errorText'
import { loadProjectTooling, type LoadedTooling } from '@/lib/projectTooling'
import { CoworkStopMenu } from '@/containers/CoworkStopMenu'
import { PromptSnapshotView } from '@/containers/PromptSnapshotView'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { useMCPServers } from '@/hooks/useMCPServers'
import { sessionDetailsLabel } from '@/lib/windowTitle'
import { autoTitleCoworkSession } from '@/lib/coworkAutoTitle'
import { runStatus } from '@/lib/runStatus'
import { chooseWorkProfile, useWorkProfiles } from '@/hooks/useWorkProfiles'
import { CoworkWorkProfilePicker } from '@/containers/CoworkWorkProfilePicker'
import { CoworkBarStack } from '@/containers/CoworkBarStack'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useJevSettings } from '@/hooks/useJevSettings'
import { workProfileAsker } from '@/lib/jev'
import { MemoryProposalList } from '@/containers/MemoryProposalCard'
import { useMemoryProposals } from '@/hooks/useMemoryProposals'


export const Route = createFileRoute(route.cowork as any)({
  beforeLoad: () => ensureCoworkEnabled(),
  component: CoworkRoute,
})

/** The current session, with any split-view panes beside it. */
function CoworkRoute() {
  return (
    <CoworkSplitWorkspace>
      <CoworkPage />
    </CoworkSplitWorkspace>
  )
}

/** Same shape the other Cowork surfaces use; kept local, as they do. */
/**
 * The window a request has to fit inside, when it is known.
 *
 * Resolved by `useModelCapabilities` (AH-195) rather than read from one
 * settings field: an OpenAI-compatible server reports its window under any of
 * several names, and reading only Flint's own `ctx_len` left every such endpoint
 * permanently "not known". When a local runtime has answered this is its
 * effective `n_ctx`, which `--fit` may have set well below the model's
 * training size -- the smaller number is the real limit.
 */
const configuredContextTokens = (
  caps: { contextTokens: number | null; source?: string } | null | undefined,
  acceptedPrompt?: number | null
): number | null =>
  coworkWindow({
    // The user's Max Context Tokens is a decision about this window, the
    // same one Chat honours; a bundled family guess is not.
    userSet:
      useAssistant.getState().currentAssistant?.parameters?.max_context_tokens,
    capabilities: caps,
    acceptedPrompt,
  })

/** The largest prompt the provider has already accepted in these turns. */
const largestAcceptedPrompt = (
  turns: readonly { usage?: { prompt_tokens?: number } }[] | undefined
): number =>
  (turns ?? []).reduce(
    (max, turn) => Math.max(max, turn.usage?.prompt_tokens ?? 0),
    0
  )

/** Stable empty lane, so a session with no run does not re-render per write. */
const NO_LIVE_TURNS: CoworkTurn[] = []

/** Below 768px Cowork shows one of these at a time. */
type CoworkPhoneView = 'content' | 'output' | 'details'
const PHONE_VIEWS: readonly CoworkPhoneView[] = ['content', 'output', 'details']

/** Shared so a rejected Tauri command never renders as `[object Object]`. */
const messageOf = errorText

/** A session title for a request: a `/command` is named as typed. */
const slashTitle = (text: string) => {
  const slash = parseSlashMarker(text)
  return slash ? slashDisplay(slash.invocation) : text
}

const NO_BROWSER_REPORTS: VerifyReport[] = []

// Exported for split view, which shows a session in a pane of its own.
export function CoworkPage() {
  const { t } = useTranslation()
  // In a split-view pane: that pane's session, not the current one.
  const coworkPane = useCoworkPane()
  const serviceHub = useServiceHub()
  // The session's own model when it has one (#215): the picker no longer
  // mirrors a session's choice into the global store, so the readiness card
  // and capability checks read it from the session, as the run does.
  const {
    selectedModel: globalModel,
    selectedProvider: globalProvider,
    getProviderByName,
    providers: modelProviders,
  } = useModelProvider()
  const viewedModel = useCoworkSessions(
    (s) =>
      s.sessions.find((x) => x.id === (coworkPane?.sessionId ?? s.currentId))
        ?.model
  )
  const { selectedModel, selectedProvider } = useMemo(
    () =>
      selectionForThreadModel(viewedModel, {
        selectedModel: globalModel,
        selectedProvider: globalProvider,
        getProviderByName,
      }),
    // `modelProviders` is why getProviderByName's answer can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewedModel, globalModel, globalProvider, getProviderByName, modelProviders]
  )
  // Resolved once for the route: the readiness card, the context measurement
  // and the run all have to be talking about the same window.
  // The snapshot of the dispatch now in flight, so its reply's usage can be
  // recorded against the payload it actually counted.
  // By session: the sink reports which session a dispatch was for, and a
  // snapshot from one session's run must not be stamped on another's reply.
  const lastSnapshotRef = useRef<Record<string, PromptSnapshotRef>>({})
  const modelCapabilities = useModelCapabilities(
    selectedModel as never,
    selectedProvider as never
  )

  const sessionModel = useCoworkSessions(
    (s) =>
      s.sessions.find((x) => x.id === (coworkPane?.sessionId ?? s.currentId))
        ?.model
  )
  // What the composer checks before sending: the same resolution the run
  // uses (session model, then the picker's), never the bare global picker.
  const composerModel = useMemo(() => {
    const resolved = resolveCoworkModel(sessionModel, {
      selectedProvider: globalProvider,
      selectedModel: globalModel,
      providers: modelProviders,
    })
    return {
      selection: {
        selectedProvider: resolved.choice?.provider ?? globalProvider,
        selectedModel: resolved.model,
      },
      unavailable: resolved.model ? undefined : resolved.unavailable?.id,
    }
  }, [sessionModel, globalProvider, globalModel, modelProviders])

  // A session whose model has gone away asks for another before it runs, rather
  // than quietly taking whatever the picker holds.
  const confirmSessionModel = useCallback(() => {
    const gone = unavailableModels([sessionModel])
    if (gone.length === 0) return { status: 'ok' as const }
    return promptReplaceModels(t('common:modelReplace.thisSession'), gone).then((choices) => {
      const pick = choices?.[modelKey(gone[0])]
      const sid = coworkPane?.sessionId ?? useCoworkSessions.getState().currentId
      if (!pick || !sid) return { status: 'stop' as const }
      useCoworkSessions.getState().setModel(sid, pick)
      return { status: 'retry' as const, modelId: pick.id }
    })
  }, [sessionModel, coworkPane?.sessionId, t])

  const sessions = useCoworkSessions((s) => s.sessions)
  const routeCurrentId = useCoworkSessions((s) => s.currentId)
  const currentId = coworkPane?.sessionId ?? routeCurrentId
  // Read at call time by every handler that resolves "the session": in a
  // split pane it must be the pane's own, not the global selection.
  const paneSessionIdRef = useRef(coworkPane?.sessionId)
  paneSessionIdRef.current = coworkPane?.sessionId
  // The split pane this page is in, when it is a pane beside the main one:
  // `/new` there replaces the pane's session instead of the main pane's.
  const sidePaneId = usePaneChrome()?.paneId
  const sidePaneIdRef = useRef(coworkPane ? sidePaneId : undefined)
  sidePaneIdRef.current = coworkPane ? sidePaneId : undefined
  // The transcript's container, so the scroll node found is this page's own
  // and not the first transcript in the document (another split pane's).
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const session = useMemo(
    () => sessions.find((s) => s.id === currentId) ?? null,
    [sessions, currentId]
  )
  // Opening a session draws its history at once; see lib/messageEntry.
  const openedSessionRef = useRef<string | null>(null)
  if (openedSessionRef.current !== (session?.id ?? null)) {
    openedSessionRef.current = session?.id ?? null
    markConversationOpened()
  }
  const folder = session?.folder ?? null
  // Folders attached beside the primary, like a multi-root workspace.
  const sessionExtraFolders = session?.extraFolders
  const extraFolders = useMemo(
    () => extraFoldersOf({ folder, extraFolders: sessionExtraFolders }),
    [folder, sessionExtraFolders]
  )
  // Apply to folder copies into the primary or any extra folder; a sandbox
  // path that starts with an extra folder's name goes to that folder.
  const applyFolders = useMemo(
    () => (folder ? [folder, ...extraFolders] : []),
    [folder, extraFolders]
  )
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
  const [pendingFolder, setPendingFolder] = useState<Record<string, string>>({})
  const [pendingAccess, setPendingAccess] = useState<Record<string, AccessMode>>({})
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

  // Everything about a run is the viewed session's, read from the run store by
  // session id (janhq/jan#8905). This page used to hold one run for itself:
  // a run in one session showed as running in every other, Stop aborted
  // whichever run had started last, and a result arriving after a switch was
  // drawn under the session in view.
  const viewedId = session?.id ?? null
  const running = useCoworkRun((s) => !!(viewedId && s.runs[viewedId]))
  const liveTurns = useCoworkRun(
    (s) => (viewedId ? s.liveTurns[viewedId] : undefined) ?? NO_LIVE_TURNS
  )
  const runEnding = useCoworkRun((s) =>
    viewedId ? s.outcomes[viewedId] : undefined
  )
  const stoppedBy: RunOutcome['stoppedBy'] | null = runEnding?.stoppedBy ?? null
  const runError = runEnding?.errorText
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  /**
   * The attached folder's detected tooling (AH-068 / AH-069 / AH-070), keyed
   * by the folder it was read for so a slow read for the previous folder is
   * never shown for the next. `loaded` is null while the read is in flight.
   */
  const [tooling, setTooling] = useState<{
    folder: string
    loaded: LoadedTooling | null
  } | null>(null)
  const [projectInstructions, setProjectInstructions] = useState<string | null>(
    null
  )
  // Bumped when Flint itself writes the folder's JAN.md, so it is read again.
  const [instructionsVersion, setInstructionsVersion] = useState(0)
  const [projectInitOpen, setProjectInitOpen] = useState(false)
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
   * Flint-owned worktrees of this project that are on disk right now.
   *
   * Read from Git, not from anything persisted: the session's own record dies
   * with the process, so after a crash this is the only truthful answer to
   * where an interrupted run's work went. Listing is not authorization —
   * nothing here becomes writable.
   */
  const [foundWorktrees, setFoundWorktrees] = useState<WorktreeRecord[]>([])
  const [recoveryHiddenHere, setRecoveryHiddenHere] = useState(false)
  useEffect(() => {
    setRecoveryHiddenHere(folder ? recoveryHidden(folder) : false)
  }, [folder])
  // Worktrees other sessions hold, and the sessions that still exist: another
  // live session's worktree is never offered here.
  const coworkSessionIds = useCoworkSessions(
    useShallow((s) => s.sessions.map((one) => one.id))
  )
  const heldWorktreePaths = useCoworkWorktrees(
    useShallow((s) =>
      Object.entries(s.bySession)
        .filter(([id]) => id !== session?.id)
        .map(([, record]) => record.path)
    )
  )
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
      // hold a run to a Flint-owned worktree and not to the user's folder. A
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

  // Parallel sessions on one folder: a new session in a Git folder works in
  // its own worktree and branch by default (Settings > Agent tools).
  const autoWorktree = useAutoSessionWorktree({
    sessionId: session?.id ?? null,
    title: session?.title,
    folder,
    extraFolders,
    access,
    turns: session?.turns.length ?? 0,
    capabilityKnown: capabilityState.known,
    managedWorktreeCapable:
      capabilityState.known && capabilityState.managedWorktree,
    busy: running,
    currentBinding: () => bindingRef.current,
  })

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
   * back changes what Flint may do next, not what already happened.
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
   * The subagents saved in Flint.
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

  // Counted only to say that they are not offered here (the run is given none).
  const settingsMcpServers = useMCPServers(
    (s) => Object.values(s.mcpServers).filter((c) => c?.active).length
  )
  const doctorResults = useModelDoctor((s) => s.results)
  const browserReports =
    useBrowserVerify((s) => (session?.id ? s.reports[session.id] : undefined)) ?? NO_BROWSER_REPORTS
  // Model, context, MCP and local runtime are facts only this page holds; the
  // backend leaves them "checking" until they are reported.
  const rendererReports = useMemo(
    () =>
      rendererReadinessReports({
        model: selectedModel?.id
          ? {
              id: selectedModel.id,
              provider: selectedProvider ?? '',
              supportsTools: selectedModel.capabilities
                ? selectedModel.capabilities.includes('tools')
                : null,
              observedTools: observedToolsFact(
                currentDoctorResult(
                  doctorResults,
                  selectedProvider ? getProviderByName(selectedProvider) : undefined,
                  selectedModel ?? undefined
                )
              ),
            }
          : null,
        contextTokens: configuredContextTokens(modelCapabilities),
        settingsMcpServers,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedModel, selectedProvider, modelCapabilities, settingsMcpServers, doctorResults]
  )
  const workspacePath = useSessionWorkspacePath(session?.id)
  const webSearchEnabled = useWebSearchConfig((s) => s.webSearchEnabled)
  const hasTurns = (session?.turns?.length ?? 0) > 0
  /**
   * What a run started now would send, before one has.
   *
   * Pure construction only: the system prompt with the project instructions
   * the run would carry, and the tool set from schemas already in hand. The
   * backend's tool schemas are never fetched for this -- that probes
   * readiness -- so when none are cached the card says that part is measured
   * at first run. Retrieved memory and the toolchain probe are left out for
   * the same reason; the run's own measurement replaces this once it exists.
   */
  const preRunContext = useMemo<ContextAccounting | null>(() => {
    if (runContext) return null
    const planMode = isReadOnly(mode)
    const subagentNames = subagentDefs.map((d) => d.name)
    return coworkPreRunContext({
      prompt: {
        workspacePath,
        readOnlyFolder: folder,
        extraFolders,
        worktreeBranch:
          effective.destination === 'managed'
            ? (worktree?.branch ?? null)
            : null,
        gitBranch,
        projectInstructions,
        compatInstructions: compatInstructionBlocks(compat),
        projectTooling:
          folder && tooling?.folder === folder
            ? (tooling.loaded?.prompt ?? null)
            : null,
        planMode,
        bashAvailable: sandboxEnforces(),
        subagentNames,
        webSearch: webSearchEnabled,
        platform: IS_WINDOWS ? 'windows' : IS_MACOS ? 'macos' : 'linux',
        shellFlavor: IS_WINDOWS ? 'powershell' : 'posix',
        mcpServers: [],
      },
      tools: {
        planMode,
        webSearch: webSearchEnabled,
        allowSubagents: true,
        subagentNames,
      },
      backendSchemas: peekAgentToolSchemas(folder ?? undefined, 'session'),
      messages: hasTurns ? null : [],
      configuredContextTokens: configuredContextTokens(modelCapabilities),
    })
  }, [
    runContext,
    mode,
    subagentDefs,
    workspacePath,
    folder,
    extraFolders,
    effective.destination,
    worktree?.branch,
    gitBranch,
    projectInstructions,
    compat,
    tooling,
    webSearchEnabled,
    hasTurns,
    modelCapabilities,
  ])
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
      // Only the read for this folder: a late answer for another is ignored.
      tooling: folder
        ? tooling?.folder === folder && tooling.loaded
          ? tooling.loaded.readiness
          : { state: 'loading' }
        : undefined,
      // From the run's own payload once there is one. Before that the
      // categories that depend on it stay unknown rather than zero: a run that
      // has not been built has not sent nothing, it has sent nothing *yet*.
      context:
        runContext ??
        preRunContext ??
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
    tooling,
    advertisedToolCount,
    runContext,
    preRunContext,
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
  const sessionDetailsSummary = useMemo(
    () => sessionDetailsLabel(readiness.folder, readiness.branch),
    [readiness.folder, readiness.branch]
  )

  // A retake re-uses the skills of the turn it takes again -- that session's
  // turn, not whichever session ran last.
  const runSkillsRef = useRef<Record<string, ReturnType<typeof resolveSkills>>>(
    {}
  )
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = session?.id ?? null

  /**
   * Flint's own data folder, so an imported MCP server can be kept out of it.
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
      // The session's extra folders, readable to a confined server as they
      // are to the run's own tools.
      readRoots: extraFolders,
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
  const liveUsage: Usage | null = useCoworkRun(
    (s) => (viewedId ? s.usage[viewedId] : undefined) ?? null
  )
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
  const openCode = useCallback(
    (tab: CodeTab, options: CodeOpenOptions = {}) => {
      const sid = ensureCurrentSession(paneSessionIdRef.current)
      const store = useCoworkSessions.getState()
      const current = store.sessions.find((s) => s.id === sid)
      store.setCodePanel(
        sid,
        openTabAt(current?.codePanel ?? emptyCodePanelState(), tab, options)
      )
      // In the background the tab is queued without leaving what is on screen.
      if (!options.background) setRail({ kind: 'code' })
    },
    [setRail]
  )

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
  // With a live grant the backend rebases relative paths onto the write
  // root; without one they are the sandbox's.
  const relativeIsProject = !!runCarries(effective, {
    folder,
    grantId: liveGrant?.grantId ?? null,
  }).writeGrant
  const resolveToolPath = useCallback(
    (path: string) =>
      resolveCodePath(path, {
        treeRoot,
        workspacePath,
        extraFolders,
        relativeIsProject,
        hasSession: !!session?.id,
      }),
    [treeRoot, workspacePath, extraFolders, relativeIsProject, session?.id]
  )
  const openToolPath = useCallback(
    (path: string, options?: CodeOpenOptions) => {
      const resolved = resolveToolPath(path)
      // The tree the Code panel browses, so the tab is not born detached in a
      // managed session.
      const projectKey = projectKeyOf(treeRoot)
      if (resolved.kind === 'project' && projectKey) {
        openCode(projectTab(resolved.rel, projectKey), options)
      } else if (resolved.kind === 'sandbox' && session?.id) {
        openCode(sandboxTab(resolved.rel, session.id), options)
      }
    },
    [resolveToolPath, treeRoot, openCode, session?.id]
  )
  /** Why a path cannot be opened, for its tooltip. */
  const checkToolPath = useCallback(
    (path: string): CodePathCheck => {
      const resolved = resolveToolPath(path)
      return resolved.kind === 'unresolved'
        ? {
            ok: false,
            reason: t(`common:codePanel.unresolved.${resolved.reason}`),
          }
        : { ok: true }
    },
    [resolveToolPath, t]
  )
  /**
   * A tool path as shown: relative to the sandbox or the attached folder it
   * is in, else just its name. The full path stays in the tooltip.
   */
  const displayToolPath = useCallback(
    (path: string) =>
      // Roots in order, for paths the Code panel cannot open (non-source).
      shortToolPath(resolveToolPath(path), path, [
        ...(workspacePath ? [workspacePath] : []),
        ...(treeRoot ? [treeRoot] : []),
        ...extraFolders,
      ]),
    [resolveToolPath, extraFolders, workspacePath, treeRoot]
  )
  // The folders a path in a reply may open from: sandbox, project tree,
  // attached folder and extras.
  const pathLinkRoots = useMemo(
    () =>
      [workspacePath, treeRoot, folder, ...extraFolders].filter(
        (r): r is string => typeof r === 'string' && r.length > 0
      ),
    [workspacePath, treeRoot, folder, extraFolders]
  )
  /** Show a changed file in Changes. */
  const openToolDiff = useCallback(
    (path: string) => setRail({ kind: 'diff', focusPath: path }),
    [setRail]
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
      // Every attached folder is inside, not only the primary one.
      if (isInsideAnyFolder(extraFolders, path)) return 'project'
      return 'external'
    },
    [treeRoot, workspacePath, extraFolders]
  )

  /**
   * Write the run's origin ledger, from evidence rather than from the model.
   *
   * Successful Flint file calls are the only thing claimed outright. Everything
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
          // An extra folder is attached directly, never worktreed, so a
          // write there landed in the user's own folder even in a managed run.
          destination:
            destination === 'managed' &&
            isInsideAnyFolder(extraFolders, event.path)
              ? 'repository'
              : destinationOfOrigin(event.origin, destination),
          ok: true,
        }))

      let endDifferences: string[] = []
      if (tree) {
        try {
          const status = await loadGitStatus(tree, 'all')
          endDifferences = (status?.files ?? []).map((file) => file.path)
        } catch {
          // Nothing found is nothing claimed: a failed read leaves the ledger
          // with Flint's own calls and no assertions about anything else.
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
    [originOfPath, extraFolders]
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
    [openCode, session?.id, setRail]
  )

  // The rail toolbar's four mutually-exclusive modes map onto the rail state
  // (Changes is the diff panel, Activity the tasks panel). Selecting the active
  // mode again closes it, so the toolbar toggles. Code and Preview open into
  // their own empty states, so neither is ever disabled.
  const selectRail = useCallback(
    (mode: RailMode) => {
      if (mode === 'code') ensureCurrentSession(paneSessionIdRef.current)
      const kind =
        mode === 'changes' ? 'diff' : mode === 'activity' ? 'tasks' : mode
      if (rail?.kind === kind) {
        setRail(null)
        return
      }
      setRail(kind === 'preview' ? { kind, path: lastPreviewPath } : { kind })
    },
    [lastPreviewPath, rail?.kind, setRail]
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
    // Like the tooling effect below: a slow answer for a folder no longer
    // attached must not name the branch of the one that is.
    let alive = true
    invoke<string | null>('agent_git_branch', { project: folder })
      .then((branch) => {
        if (alive) setGitBranch(branch)
      })
      .catch(() => {
        if (alive) setGitBranch(null)
      })
    return () => {
      alive = false
    }
  }, [folder])

  // Read once per attached folder. A failure is a typed state, never a throw,
  // and never stops the folder from being used.
  useEffect(() => {
    if (!folder) {
      setTooling(null)
      return
    }
    let alive = true
    setTooling({ folder, loaded: null })
    void loadProjectTooling(folder).then((loaded) => {
      if (alive) setTooling({ folder, loaded })
    })
    return () => {
      alive = false
    }
  }, [folder])

  // Every instruction file at the attached root, in one pass.
  //
  // `JAN.md` is Flint's own and the only one whose text reaches the model.
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

      // FLINT.md is the native instructions file; JAN.md is the legacy name a
      // project created before the rename still uses. Prefer FLINT.md; fall
      // back to JAN.md only when FLINT.md is simply absent (a FLINT.md that
      // exists but cannot be read is surfaced as-is, not masked by a legacy
      // file). FLINT.md wins when both exist.
      const flintProbe = await probe(NATIVE_INSTRUCTION_FILE, 'native')
      let nativeProbe = flintProbe
      if (flintProbe.content == null && !flintProbe.error) {
        const legacy = await probe(LEGACY_NATIVE_INSTRUCTION_FILE, 'native')
        if (legacy.content != null || legacy.error) nativeProbe = legacy
      }
      const probes = [
        nativeProbe,
        ...(await Promise.all(
          COMPATIBILITY_INSTRUCTION_FILES.map((name) =>
            probe(name, 'compatibility')
          )
        )),
      ]
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
      setProjectInstructions(native ? (nativeProbe.content ?? null) : null)
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
    const openingSessionId = session?.id
    const picked = await serviceHub.dialog().open({ directory: true })
    if (typeof picked !== 'string') return
    if (openingSessionId &&
      useCoworkSessions.getState().currentId !== openingSessionId) return
    const sid = ensureCurrentSession(paneSessionIdRef.current)
    if (!useCoworkRun.getState().runs[sid] && authorityMayChange(sid))
      useCoworkSessions.getState().setFolder(sid, picked)
    else setPendingFolder((pending) => ({ ...pending, [sid]: picked }))
    setPendingAccess((pending) => {
      if (!pending[sid]) return pending
      const next = { ...pending }
      delete next[sid]
      return next
    })
  }, [serviceHub, session?.id])

  const detachFolder = useCallback(async () => {
    if (!session?.id || folderHeld(session.id)) return
    await useDirectEditGrants.getState().revokeSession(session.id)
    useCoworkSessions.getState().setFolder(session.id, null)
  }, [session?.id, folderHeld])

  /**
   * Attach or detach one of the session's extra folders.
   *
   * The grant covers the folders it was issued for, so changing the set
   * withdraws it first and the session returns to Review only until the user
   * confirms again -- the same as changing the primary folder.
   */
  const addExtraFolder = useCallback(async () => {
    if (!session?.id || folderHeld(session.id)) return
    const picked = await serviceHub.dialog().open({ directory: true })
    if (typeof picked !== 'string') return
    if (folderHeld(session.id)) return
    const sid = session.id
    await useDirectEditGrants.getState().revokeSession(sid)
    useCoworkSessions.getState().addExtraFolder(sid, picked)
  }, [serviceHub, session?.id, folderHeld])

  const removeExtraFolder = useCallback(
    async (extra: string) => {
      if (!session?.id || folderHeld(session.id)) return
      const sid = session.id
      await useDirectEditGrants.getState().revokeSession(sid)
      useCoworkSessions.getState().removeExtraFolder(sid, extra)
    },
    [session?.id, folderHeld]
  )

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
          tokenCount: turn.usage?.completion_tokens ?? turn.tokenSpeed?.tokenCount,
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

  // Read-only working-tree status for the attached repo, loaded lazily and kept
  // strictly separate from the sandbox diffs above. The chip's counts combine
  // both sources so it appears whenever either has changes.
  // Re-read when a run starts or settles: a run's edits, commits and undo
  // change the tree, and a list loaded before them contradicts its own diffs.
  const git = useCoworkGitStatus(treeRoot, running)
  // "Show 'What the model received'": the per-turn row and its token count.
  // Forced on by the Verbose transcript view.
  const showPromptSnapshot = useShowPromptSnapshot()

  // Review only output into the attached folder: per file, and "Apply all".
  const applySessionId = session?.id
  const refreshGit = git.refresh
  const sandboxApply = useMemo<SandboxApplyActions | undefined>(() => {
    if (!folder || !applySessionId) return undefined
    const planFor = (path: string) =>
      planSandboxApply(workspacePath, applyFolders, path)
    return {
      planFor,
      probe: (_path, plan) =>
        probeSandboxFile({
          session: applySessionId,
          path: plan.source,
          project: plan.folder,
          destination: plan.destination,
        }),
      apply: async (path, overwrite) => {
        const plan = planFor(path)
        if (!plan) throw new Error(`${path} is not in the session sandbox`)
        const outcome = await applySandboxFile({
          session: applySessionId,
          path: plan.source,
          project: plan.folder,
          destination: plan.destination,
          overwrite,
        })
        if (outcome !== 'exists') refreshGit()
        return outcome
      },
    }
  }, [folder, applySessionId, workspacePath, applyFolders, refreshGit])

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
    if (sid && (useCoworkRun.getState().runs[sid] || !authorityMayChange(sid))) {
      setPendingAccess((pending) => ({ ...pending, [sid]: 'edit-folder' }))
      setConfirmDirectEdit(false)
      return true
    }
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
          useDirectEditGrants
            .getState()
            .authorize(sessionId, target, data, extraFolders),
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
  }, [
    session?.id,
    folder,
    extraFolders,
    serviceHub,
    effective.access,
    effective.destination,
  ])

  // Attaching a folder is the user's choice to work in it. Obtain the same
  // scoped grant as the manual access selector; until it arrives, effective
  // access remains Review only. Never override a later mode selection.
  const autoEditAttempted = useRef<Set<string>>(new Set())
  useEffect(() => {
    const current = session?.id && folder ? `${session.id}\u0000${folder}` : null
    for (const key of autoEditAttempted.current) {
      if (key !== current) autoEditAttempted.current.delete(key)
    }
  }, [session?.id, folder])
  useEffect(() => {
    const sid = session?.id
    if (!sid || !folder || access !== 'edit-folder' || liveGrant) return
    if (
      !capabilityState.known ||
      !capabilityState.directEdit ||
      useCoworkActiveWork.getState().blockingKind(sid)
    ) return
    const key = `${sid}\u0000${folder}`
    if (autoEditAttempted.current.has(key)) return
    autoEditAttempted.current.add(key)
    const done = useCoworkActiveWork.getState().acquire({
      sessionId: sid,
      kind: 'authorizing',
      authority: { folder, access: effective.access, destination: effective.destination },
    })
    void (async () => {
      try {
        const dataFolder = await serviceHub.app().getJanDataFolder()
        if (!dataFolder) return
        const result = await useDirectEditGrants
          .getState()
          .authorize(sid, folder, dataFolder, extraFolders)
        if (!result.ok) {
          if (result.reason !== 'superseded') toast.error(result.reason)
          return
        }
        const current = useCoworkSessions
          .getState()
          .sessions.find((entry) => entry.id === sid)
        if (current?.folder !== folder || accessOf(current) !== 'edit-folder') {
          await useDirectEditGrants.getState().revokeSession(sid)
        }
      } catch (error) {
        toast.error(String(error))
      } finally {
        done()
      }
    })()
  }, [
    session?.id,
    folder,
    access,
    liveGrant,
    capabilityState.known,
    capabilityState.known && capabilityState.directEdit,
    effective.access,
    effective.destination,
    serviceHub,
    extraFolders,
  ])

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
      const title = useCoworkSessions
        .getState()
        .sessions.find((x) => x.id === sid)?.title
      const created = await useCoworkWorktrees
        .getState()
        .ensure(sid, folder, dataFolder, {
          title: title && title !== DEFAULT_SESSION_TITLE ? title : undefined,
        })
      if (!created.ok) {
        toast.error(created.reason)
        return false
      }
      // The user may have moved on during the round trip; authorizing for a
      // binding nobody is looking at would leave authority nobody asked for.
      const now = bindingRef.current
      if (now.sessionId !== sid || now.folder !== folder) return false

      // Only the primary folder is worktreed. The session's extra folders are
      // attached directly, beside the worktree, under the same grant -- where
      // the platform can confine a run to them at all (not on Windows, where
      // only Flint-owned worktrees can be written).
      const granted = await useDirectEditGrants
        .getState()
        .authorize(sid, created.record.path, dataFolder, extraFolders)
      if (!granted.ok) {
        if (granted.reason !== 'superseded') toast.error(granted.reason)
        return false
      }
      useCoworkSessions.getState().setAccess(sid, 'managed-worktree')
      return true
    } finally {
      done()
    }
  }, [
    session?.id,
    folder,
    extraFolders,
    serviceHub,
    effective.access,
    effective.destination,
  ])

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
   * tree, so a branch someone left half-finished was reported as Flint having
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
  // Scoped to the session on screen: the backend lists only that
  // conversation's jobs, and the list is dropped the moment the session
  // changes, so one session's jobs can never settle -- or block -- another's.
  // One shared poller serves every Cowork page mounted in split view.
  const liveJobsSession = session?.id
  const liveJobs: LiveJob[] = useLiveJobs(liveJobsSession)

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

  // A running task keeps its original binding. Apply choices made while it
  // runs only after every task and background job in this session has ended.
  useEffect(() => {
    const sid = session?.id
    if (!sid || running || blockingKind) return
    if (pendingFolder[sid]) {
      useCoworkSessions.getState().setFolder(sid, pendingFolder[sid])
      setPendingFolder((pending) => {
        const next = { ...pending }
        delete next[sid]
        return next
      })
      return
    }
    const choice = pendingAccess[sid]
    if (!choice) return
    setPendingAccess((pending) => {
      const next = { ...pending }
      delete next[sid]
      return next
    })
    if (choice === 'managed-worktree') void authorizeManagedWorktree()
    else if (choice === 'edit-folder') void authorizeDirectEdit()
    else void returnToReviewOnly()
  }, [session?.id, running, blockingKind, pendingFolder, pendingAccess,
    authorizeManagedWorktree, authorizeDirectEdit, returnToReviewOnly])

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
  // It also says how the command ended -- exit code, signal, or a stop request
  // -- so an uncollected failure reads as a failure, not a success.
  useEffect(() => {
    if (!liveJobsSession) return
    const state = useCoworkActivity.getState()
    for (const job of liveJobs) {
      if (!job.finished) continue
      const task = findTaskByJob(state, job.jobId, liveJobsSession)
      if (task && task.status === 'running') {
        const patch = finishedJobPatch(job)
        state.patchTask(task.id, { ...patch, endedAt: patch.endedAt ?? Date.now() })
      }
    }
  }, [liveJobs, liveJobsSession])

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
  // `setRail` is bound to the session in view; with empty deps these kept the
  // one from the first render and opened the rail for no session at all.
  const showTaskInPanel = useCallback(
    (task: ActivityTask) => {
      setRail({ kind: 'tasks' })
      setFocusWorkflowId(task.workflowId)
      setFocusTaskId(task.id)
    },
    [setRail]
  )
  const showWorkflowInPanel = useCallback(
    (workflowId: string) => {
      setRail({ kind: 'tasks' })
      setFocusTaskId(null)
      setFocusWorkflowId(workflowId)
    },
    [setRail]
  )

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
      // Into the execution record too, in sequence with the calls around it:
      // a stop is something the run did, and a stop that failed is one the
      // audit has to show as having failed.
      if (result.outcome === 'cancelled' || result.outcome === 'failed') {
        void recordLifecycle(
          {
            session: task.sessionId,
            run: task.workflowId,
            source: 'cowork',
            parent: task.callId,
          },
          {
            id: `stop:${task.callId}:${Date.now()}`,
            lifecycle: task.kind === 'shell' ? 'background-job' : 'subagent',
            phase: result.outcome === 'cancelled' ? 'cancelled' : 'failed',
            summary:
              task.kind === 'shell'
                ? `Stopped ${task.jobId ?? 'a command'}`
                : `Stopped ${task.title}`,
            detail: result.error ?? '',
            jobId: task.jobId,
            taskId: task.kind === 'agent' ? task.callId : undefined,
          }
        )
      }
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
  /**
   * Memories this session's agent proposed that wait for an answer. With
   * automatic saving off (the default) a proposed memory is only saved once
   * the user approves it, and Cowork never showed the question, so nothing
   * the agent asked to remember was ever kept.
   */
  const {
    proposals: memoryProposals,
    location: memoryProposalLocation,
    reload: reloadMemoryProposals,
    onResolved: onMemoryProposalResolved,
  } = useMemoryProposals({
    sessionId: session?.id,
    projectRoot: folder ?? undefined,
    enabled: Boolean(session?.id),
  })
  const navigateTo = useNavigate()
  // A proposal is written by a tool call during the run: read once it ends.
  useEffect(() => {
    if (!running) void reloadMemoryProposals()
  }, [running, reloadMemoryProposals])

  // The status line's phase: shown for the whole run, not only the gaps.
  const runStatusNow = useMemo(
    () => runStatus(running, displayedTurns),
    [running, displayedTurns]
  )


  /**
   * Drive one request. `text` is null for a resume — a retry after a failure
   * re-runs the committed history rather than re-sending the question, which
   * would leave the model reading it twice.
   */
  const runRequest = async (
    text: string | null,
    from?: QueuedMessageSender,
    // Flint's own request (the result card's Continue): sent to the model,
    // not drawn as something the user said.
    hidden = false,
    // Files attached to this message: documents staged in the composer, and
    // the media it passed along. Without this they were dropped on send.
    attachmentInput?: CoworkAttachmentInput
  ) => {
    const sid = ensureCurrentSession(paneSessionIdRef.current)
    // This session's run only: another session running is no reason to wait.
    if (useCoworkRun.getState().runs[sid]) return
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
        toast.error(`Could not read ${f.name}: ${f.error}`)
      }
      if (attached.truncated.length > 0) {
        toast.info(`Only part of ${attached.truncated.join(', ')} fits in one message.`)
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
    if (!selectedModel?.id) {
      toast.error(
        resolved.unavailable
          ? t('common:sessionModelUnavailable', { model: resolved.unavailable.id })
          : t('common:selectModel')
      )
      return
    }
    // Without tool calling the transport drops the tool set silently, and the
    // agent then narrates work it never did. Refusing up front is honest; a
    // toolless "agent" run is worse than no run.
    if (!selectedModel.capabilities?.includes('tools')) {
      toast.error(t('common:modelNoTools', { model: selectedModel.id }))
      return
    }
    // A restored session may remember Managed worktree while its process-local
    // grant is still being reissued. Do not start a Review run against the
    // source folder: history would point at a worktree the run cannot read.
    if (access === 'managed-worktree' && effective.destination !== 'managed') {
      const key = effectiveDowngradeKey(effective)
      if (key) toast.error(t(key))
      return
    }
    // Another session's message is not what this session is about.
    if (text && !from && !hidden && current?.title === 'New session') {
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
    const handle = beginRun(sid, runId, controller)
    useCoworkRun.getState().startRun(sid, runId)
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
    let runTurns: CoworkTurn[] = text
      ? [
          {
            role: 'user',
            content: attached ? `${text}${attached.shownNote}` : text,
            ...(attached && attached.keptImages.length > 0 ? { images: attached.keptImages } : {}),
            ...(from ? { from: agentAttribution(from) } : {}),
            ...(hidden ? { hidden: true } : {}),
          },
        ]
      : []
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
    // AH-026: the live lane is also kept with the session while the run goes,
    // so a run the app is killed under comes back as an interrupted turn.
    const runStartedAt = Date.now()
    const runBaseCount = current?.messages?.length ?? 0
    let lastCheckpointAt: number | undefined
    const saveInFlight = (step = false) => {
      const at = Date.now()
      if (!checkpointDue(lastCheckpointAt, at, step)) return
      lastCheckpointAt = at
      // Only while this run still owns the session's live lane.
      if (useCoworkRun.getState().runs[sid]?.runId !== runId) return
      useCoworkSessions
        .getState()
        .setInFlight(sid, inFlightCheckpoint(runId, runStartedAt, runBaseCount, runTurns, at))
    }
    // Text deltas publish at most once per frame: a set per token woke every
    // `useCoworkRun` subscriber and re-rendered this route per token, which is
    // what made scrolling a streaming transcript lag. Any other write publishes
    // at once and takes the queued text with it, so ordering is unchanged.
    const textFrame = createFrameBatch(() => publish())
    const publish = () => {
      textFrame.cancel()
      useCoworkRun.getState().setRunTurns(sid, runId, [...runTurns])
      saveInFlight()
    }
    const pushLive = (
      turns: CoworkTurn[],
      snapshot: PromptSnapshotRef | undefined = lastSnapshotRef.current[sid]
    ) => {
      // AH-078. Bind each assistant row to the dispatch that produced it,
      // here, because here is where the row first exists: at dispatch the
      // lane holds the user turn and nothing else, so a reference written
      // then has nothing to land on. The snapshot is this session's latest,
      // so a continuation, a retry and a compaction each carry their own --
      // unless the caller names the step's own (see `stepSnapshot`).
      const stamped = turns.map((turn) =>
        turn.role === 'assistant' && !turn.promptSnapshot && snapshot
          ? { ...turn, promptSnapshot: snapshot }
          : turn
      )
      runTurns = [...runTurns, ...stamped]
      publish()
      // AH-083: the memories this row's request carried now know the turn and
      // the exact snapshot they went out in. Here for the same reason as the
      // stamp above: this is where the row, its memory and its snapshot meet.
      // Named by this run's session, never the one in view.
      for (const turn of stamped) {
        if (turn.role !== 'assistant' || !turn.memory?.injectedIds.length) continue
        void recordMemoryUses({
          sessionId: sid,
          projectRoot: runAuthority.folder ?? undefined,
          memory: turn.memory,
          turnId: turn.promptSnapshot?.id
            ? `turn-${turn.promptSnapshot.id}`
            : undefined,
          snapshotId: turn.promptSnapshot?.id,
        })
      }
    }
    const mutateLive = (apply: (turns: CoworkTurn[]) => CoworkTurn[]) => {
      const next = apply(runTurns)
      if (next === runTurns) return
      runTurns = next
      publish()
    }
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
      runWorkDone()
      for (const resolve of handle.pendingAsks.values()) resolve(null)
      handle.pendingAsks.clear()
      // What the user asked is kept, as it is when a turn stops later on.
      const prior = current?.messages ?? []
      useCoworkSessions.getState().commitTurns(
        sid,
        runTurns,
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
    let runBaseline: GitBaseline | null = null
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
     * The session's extra attached folders, frozen with the run. Readable
     * always; writable only under the run's grant and where the platform can
     * confine a run to a user folder (the grant leaves them out otherwise).
     */
    const runExtraFolders = extraFoldersOf(current ?? { folder: null })
    const runExtraFoldersWritable = !!runGrant && canEditDirectly
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
    let runTooling: string | null = null
    if (runReadRoot) {
      const cached =
        tooling?.folder === runReadRoot ? tooling.loaded : null
      const loaded = cached ?? (await prepared(loadProjectTooling(runReadRoot)))
      if (loaded === STOPPED) return
      runTooling = loaded.prompt
    }
    const transport = new CoworkChatTransport(sid, {
      // Captured now: every step of this run uses it, whatever the picker
      // says by then (janhq/jan#8905).
      model: { provider: selectedProvider, id: selectedModel.id },
      planMode: isReadOnly(runMode),
      subagentNames: runAgents.map((d) => d.name),
      // Always on at depth 0, even with nothing saved: a one-off subagent with
      // an inline `system_prompt` is first-class, as it is in Rust.
      allowSubagents: true,
      webSearch,
      workspacePath,
      readOnlyFolder: runReadRoot,
      extraFolders: runExtraFolders,
      extraFoldersWritable: runExtraFoldersWritable,
      // Read from the run's frozen snapshot, not re-derived here: the model
      // must be told exactly what the gate and the ledger will act on.
      folderAccess: promptFolderAccess(origins),
      worktreeBranch: worktree?.branch ?? null,
      gitBranch,
      projectInstructions,
      // Only what the resolver made active: a file that is present but not
      // switched on, oversized, or pointing outside the folder contributes
      // nothing here.
      compatInstructions: compatInstructionBlocks(runCompat),
      projectTooling: runTooling,
      openingInspection: inspecting,
      // What the shell can and cannot do, stated up front. Without it the
      // model learned by failing: probing the disk for runtimes, trying POSIX
      // syntax, and hunting for MCP servers Cowork never offers.
      platform: IS_WINDOWS ? 'windows' : IS_MACOS ? 'macos' : 'linux',
      shellFlavor: IS_WINDOWS ? 'powershell' : 'posix',
      runnable: toolchains?.runnable,
      unavailable: toolchains?.unavailable,
      networkFromShell: useAgentToolsConfig.getState().bashNetworkEnabled,
      mcpServers: [],
    })
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
    let stepSnapshot: PromptSnapshotRef | undefined
    // Per-step generation timing, so a provider that reports no llama.cpp
    // `timings` (every remote model, including pxa-27b) still gets a
    // tokens/sec figure -- computed from output tokens over the streaming
    // span, the same fallback the Chat transport uses. First and last delta of
    // the current step; reset when the step settles.
    let genFirstAt = 0
    let genLastAt = 0
    const run: RunContext = {
      sessionId: sid,
      runId,
      // The turn's own question, or the one being taken again -- never an
      // instruction the app sent to continue an approved plan or retry what
      // the last run left open.
      title: runTitle(hidden ? null : text, current?.messages) || t('common:tasks.untitledRun'),
      model: selectedModel.id,
    }

    const sink: StreamSink = {
      onText: (delta) => {
        // Mark the generation span for this step's tokens/sec fallback: the
        // first delta starts it, every delta extends it. Tool execution emits
        // no text, so it is excluded from the span.
        const now = Date.now()
        if (genFirstAt === 0) genFirstAt = now
        genLastAt = now
        const last = runTurns[runTurns.length - 1]
        if (last && last.role === 'assistant') {
          last.content += delta
          textFrame.schedule()
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
        const row = runTurns.find((turn) => turn.callId === call.toolCallId)
        if (row) {
          row.args = call.input
          publish()
          // #321: checkpointed now, not at the next step or text delta. A
          // crash between here and the step's end otherwise left the saved
          // call without its arguments, and resuming replayed it without them.
          saveInFlight(true)
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
          ...runTurns,
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
      // A child in the run's own tree shares its extra folders; one given an
      // isolated checkout holds a grant for that checkout alone.
      const childExtras = destination ? [] : runExtraFolders
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
          // The same identity the child's dispatched calls carry, for the
          // calls the runner refuses without dispatching.
          activity: () => ({
            session: sid,
            run: runId,
            agent: resolved.name,
            // AH-110: what a change it makes is attributed to. A role Flint
            // ships is a role; anything else is an agent by that name.
            agentId: subagentActorId(resolved),
            parentAgent: 'agent',
            project: workspacePath ?? '',
          }),
          // The parent's instance: a second one would mean a second
          // llama-server load for the same model.
          model: transport.model,
          providerOptions: transport.reasoningProviderOptions(),
          parentTools: transport.advertisedTools,
          system: {
            workspacePath,
            readOnlyFolder: childFolder,
            extraFolders: childExtras,
            extraFoldersWritable: !destination && runExtraFoldersWritable,
            bashAvailable: sandboxEnforces(),
            // The parent's frozen answers, handed down unchanged: a
            // child never resolves its own access or its own
            // instructions.
            folderAccess: promptFolderAccess(origins),
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
              onTask: async () => ({
                output: 'A subagent cannot dispatch subagents.',
                isError: true,
              }),
            }, toolSignal),
          events: {
            onQueued: (waiting) => {
              // The dispatching call's item says it is waiting for a slot,
              // in sequence with everything else the run did.
              void recordToolActivity({
                call: callId,
                tool: 'task',
                session: sid,
                run: runId,
                agent: 'main',
                source: 'cowork',
                phase: 'queued',
                detail: `waiting for a slot (position ${waiting})`,
              })
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
    let learnedWindow: number | null = null
    const summarizeRun = modelSummarizer({
      provider: selectedProvider,
      modelId: selectedModel.id,
      session: sid,
      maxOutputTokens: compactionPolicy.summaryMaxTokens,
      window: () => runWindow ?? learnedWindow,
      model: () => transport.model,
    })
    const compactRun = async (
      msgs: UIMessage[],
      why: 'threshold' | 'context-error',
      signal: AbortSignal,
      failure?: unknown
    ): Promise<UIMessage[] | null> => {
      if (!autoCompact) return null
      if (why === 'context-error' && runWindow == null) {
        const limit = parseServerContextLimit(
          (failure as { data?: unknown } | null)?.data ?? null,
          failure instanceof Error ? failure.message : String(failure ?? '')
        )
        if (limit) {
          learnedWindow = limit.contextTokens
          rememberServerLimit(
            {
              provider: selectedProvider ?? '',
              baseUrl:
                (useModelProvider.getState().getProviderByName(selectedProvider)
                  ?.base_url as string) ?? '',
              model: selectedModel.id,
            },
            limit
          )
        }
      }
      if (why === 'threshold') {
        const now = transport.measureContext(msgs, runWindow ?? learnedWindow)
        const window = compactionWindow(
          now.budget.known === false ? null : now.budget.tokens
        )
        if (!shouldCompact(accountedTotal(now).tokens, window)) return null
      }
      setCompacting(true)
      let result: Awaited<ReturnType<typeof compactHistory>>
      try {
        result = await compactHistory(msgs, {
          summarize: summarizeRun,
          keepRecent: compactionPolicy.keepRecent || DEFAULT_KEEP_RECENT,
          reason: why,
          signal,
        })
      } finally {
        setCompacting(false)
      }
      if (!result) return null
      pushLive([{ role: 'assistant', content: '', compaction: result.record }])
      void recordLifecycle(
        { session: sid, run: runId, source: 'cowork' },
        {
          id: `compaction:${runId}:${result.record.at}`,
          lifecycle: 'compaction',
          phase: 'succeeded',
          summary: `Compacted ${result.record.summarizedCount} messages into a summary`,
        }
      )
      return result.messages
    }
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
    let continueWith: string | null = null
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
          sendStep: (msgs, signal, stepOpts) => {
            transport.textOnlyNext = stepOpts?.textOnly === true
            return transport.sendMessages({
              chatId: sid,
              messages: msgs,
              abortSignal: signal,
              trigger: 'submit-message',
              messageId: undefined,
            } as any)
          },
          dispatch: (call, toolSignal) =>
            withToolTiming(call.toolCallId, () =>
              dispatchCoworkTool(call, {
                activity: {
                  session: sid,
                  run: runId,
                  agent: 'main',
                  invocation: stepSnapshot?.invocation,
                },
                sessionId: sid,
                modelId: selectedModel?.id,
                readOnlyFolder: runReadRoot,
                extraFolders: runExtraFolders,
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
                      workspaceLabel: current?.folder ?? undefined,
                      preview,
                      signal,
                    }),
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
                  // Snapshot anchored at this run's prompt, so the transcript
                  // keeps one record of the plan per run.
                  useCoworkSessions
                    .getState()
                    .setTodos(sid, result.list, planAnchor)
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
                    // Into this run's own lane, whichever session is in view:
                    // that lane is what renders for this session.
                    mutateLive((turns) => attachAskToTurns(turns, askRecord))
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
                    // Held by this run's handle: answered only through this
                    // session, and settled by stopping this session alone.
                    handle.pendingAsks.set(callId, (answers) => {
                      const state = answers ? 'answered' : 'cancelled'
                      mutateLive((turns) =>
                        settleAskInTurns(turns, callId, state, answers ?? undefined)
                      )
                      // An answered proposal is no longer outstanding. Declining
                      // is recorded as a decision, not as work to pick up later.
                      if (proposal && current?.folder) {
                        useCoworkSessions.getState().setContinuity(sid, {
                          state: answers ? 'executing' : 'cancelled',
                          folder: current.folder,
                          proposal: proposal.question,
                        })
                      }
                      // An accepted opening proposal ends this read-only run
                      // and continues in a new one that can write (#296).
                      if (
                        inspecting &&
                        proposal &&
                        answers &&
                        acceptsProposal(parsed, answers)
                      ) {
                        continueWith = continuationInstruction(
                          proposal.question,
                          answers
                        )
                        resolve({
                          output: PROPOSAL_ACCEPTED_RESULT,
                          endsTurn: true,
                        })
                        return
                      }
                      // A plan review changes the session's mode, from the next
                      // message: this run's tools are frozen. Only ever towards
                      // Ask, where each change still waits for the user.
                      const review = planReviewDecision(parsed, answers)
                      if (review === 'execute' || review === 'exit') {
                        useCoworkSessions.getState().setMode(sid, 'ask')
                      }
                      // "Execute plan" leaves plan mode and carries on: this
                      // run's tools are frozen read-only, so it ends and the
                      // plan continues in a new run that can make changes.
                      // When those changes cannot reach the user's files, the
                      // user is told what to change rather than left to find
                      // "Attach a folder first" in the access menu.
                      if (review === 'execute') {
                        const notice = planExecuteNotice({
                          folder: current?.folder,
                          access: effective.access,
                        })
                        if (notice) {
                          toast.info(t(`common:coworkPlanExecute.${notice}`), {
                            duration: 12000,
                          })
                        }
                        continueWith = PLAN_EXECUTE_INSTRUCTION
                      }
                      resolve(
                        review === 'none'
                          ? renderAskResult(answers, parsed)
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
                  // AH-111: a failed member can be restarted or replaced from the
                  // Tasks panel while the team runs; the control lives as long
                  // as the team does.
                  const teamControl = new TeamControl()
                  useTeamControls.getState().register(teamTaskId, teamControl)
                  try {
                    const outcome = await runTeam(tasks, {
                      // The turn's controller: stopping the run stops the team,
                      // and every child hangs off a signal chained to this one.
                      signal: controller.signal,
                      allowParallel,
                      control: teamControl,
                      decisionWindowMs: COWORK_DECISION_WINDOW_MS,
                      onControl: (request, result) => {
                        if (!result.ok || request.kind === 'finish') {
                          if (!result.ok) toast.error(result.refusal.message)
                          return
                        }
                        const childTask = taskIdFor(sid, runId, `${callId}:${request.taskId}`)
                        const activity = useCoworkActivity.getState()
                        const prior = activity.tasks[childTask]
                        activity.patchTask(childTask, {
                          status: 'running',
                          endedAt: undefined,
                          attempts: (prior?.attempts ?? 0) + 1,
                          ...(request.kind === 'replace'
                            ? {
                                replacedWith: {
                                  agentName: request.with.subagentName,
                                  description: request.with.description,
                                },
                                ...(request.with.description
                                  ? { description: request.with.description }
                                  : {}),
                              }
                            : {}),
                        })
                      },
                      onState: (state: TeamState) =>
                        useCoworkActivity.getState().patchTask(teamTaskId, {
                          detail:
                            awaitingDecision(state) &&
                            !Object.values(state).some((s) => s.status === 'running' || s.status === 'pending')
                              ? `${teamProgress(state)} · waiting for a decision on the failed tasks`
                              : teamProgress(state),
                        }),
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
                      renderTeamReport(outcome.report) +
                        (outcome.decision === 'window-elapsed' ||
                        outcome.decision === 'not-retried'
                          ? `\n\n${renderNotRetried(outcome.report)}`
                          : ''),
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
                    useTeamControls.getState().unregister(teamTaskId)
                    // The children are done, so their authority goes back. The
                    // worktrees stay: they hold the work the team was run for,
                    // and the report names where each one is.
                    await plan.release()
                  }
                },
              }, toolSignal)
            ),
          sink,
          onStep: ({ step, result, turns, outcomes }) => {
            if (result.usage)
              useCoworkRun.getState().setUsage(sid, result.usage)
            saveInFlight(true)
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
            // AH-172: the request's own events in the canonical log, bound
            // to its invocation -- its usage (counts only) and what the
            // response was made of (sizes only; the words stay in the
            // transcript). One id per invocation, so a retried record is one.
            const stepInvocation = (stepSnapshot ?? lastSnapshotRef.current[sid])?.invocation
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
                snapshot: stepSnapshot ?? lastSnapshotRef.current[sid] ?? null,
                model: selectedModel?.id,
                usage: result.usage,
              })
            }
            // Replace the optimistic running rows with the settled ones so the
            // transcript shows results, not spinners.
            runTurns = runTurns.filter(
              (turn) =>
                !(turn.role === 'tool' && outcomes.has(turn.callId ?? '')) &&
                !(turn.role === 'assistant' && turn.content === result.text)
            )
            const liveStats = useAppState.getState().liveTokenStatsByThread[sid]
            // Prefer llama.cpp's reported generation speed; otherwise derive it
            // from output tokens over the streaming span, so remote providers
            // (pxa-27b and every other non-llama.cpp model) still show a
            // tokens/sec figure -- matching what the Chat transport does.
            const genDurationSec =
              genFirstAt > 0 && genLastAt > genFirstAt
                ? (genLastAt - genFirstAt) / 1000
                : 0
            const stepOutputTokens =
              liveStats?.completionTokens ??
              fromCoworkUsage(result.usage)?.outputTokens ??
              0
            const liveTps = liveStats?.tokensPerSecond ?? 0
            const computedTps =
              liveTps > 0
                ? liveTps
                : genDurationSec > 0 && stepOutputTokens > 0
                  ? stepOutputTokens / genDurationSec
                  : 0
            const answeredBy = transport.answering()
            const settledTurns = turns.map((turn0) => {
              const turn =
                answeredBy && turn0.role === 'assistant' && !turn0.assistant
                  ? { ...turn0, assistant: answeredBy }
                  : turn0
              return turn.role === 'assistant' &&
              turn.content === result.text &&
              computedTps > 0
                ? {
                    ...turn,
                    tokenSpeed: {
                      tokenSpeed: computedTps,
                      promptSpeed: liveStats?.promptPerSecond ?? undefined,
                      tokenCount: stepOutputTokens || undefined,
                      durationMs:
                        genDurationSec > 0
                          ? Math.round(genDurationSec * 1000)
                          : undefined,
                    },
                  }
                : turn
            })
            // Reset the generation span so the next step measures its own.
            genFirstAt = 0
            genLastAt = 0
            pushLive(settledTurns, stepSnapshot ?? lastSnapshotRef.current[sid])
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
          },
          onResponse: () => {
            stepSnapshot = lastSnapshotRef.current[sid]
          },
          activity: () => ({
            session: sid,
            run: runId,
            agent: 'main',
            invocation: stepSnapshot?.invocation,
          }),
          compact: compactRun,
          nextMessageId: (() => {
            let n = baseMessages.length
            return () => `${sid}-asst-${n++}`
          })(),
          // janhq/jan#8864. What the user chose to steer with from this
          // session's composer while the run worked (Steer now, Ctrl+Enter),
          // taken at the runner's safe boundaries. Only this
          // session's queue: input typed in another session never reaches
          // this run, whichever session is in view. Shown in the transcript
          // where it entered the conversation, marked as steering.
          hasSteering: () => hasLiveSteering(sid),
          takeSteering: async () => {
            // Mail a tool already consumed (wait_for_reply, read_messages)
            // is dropped here, so it is never injected a second time.
            const taken = await takeClaimed(sid, () =>
              // Only what the user chose to steer with (and mail). Plain
              // queued input waits and goes as its own turn after the run.
              useMessageQueue.getState().takeSteering(sid)
            )
            if (taken.length === 0) return []
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
            pushLive(
              taken.map((m) => ({
                role: 'user' as const,
                content: m.text,
                steered: true,
                // A mailbox message keeps its sender, so the transcript can
                // say who it came from and offer a reply.
                ...(m.from ? { from: agentAttribution(m.from) } : {}),
              }))
            )
            return taken.map(
              (m) =>
                ({
                  id: `${sid}-steer-${m.id}`,
                  role: 'user',
                  parts: [{ type: 'text', text: m.text }],
                }) as any
            )
          },
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
      // The load card is shared by every Cowork run: only the last one to
      // finish takes it down, so this run ending does not hide another's load.
      const othersRunning = Object.keys(useCoworkRun.getState().runs).some(
        (id) => id !== sid
      )
      if (!othersRunning) useAppState.getState().updateLoadingModel(false)
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
          runTurns,
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
        ...deriveFromTurns(runTurns, originOfPath, settledAt),
        ...subagentRuns.flatMap((run) =>
          deriveFromSubagent(run.name, run.turns, originOfPath, settledAt)
        ),
      ]
      useFileActivity.getState().record(sid, fileEvents)
      // The run's own account of what changed, generated from evidence rather
      // than written by the model that did the changing.
      void recordOrigins({ sessionId: sid, origins, events: fileEvents })
      runWorkDone()
      // Unanswered questions end with the run that asked them.
      for (const resolve of handle.pendingAsks.values()) resolve(null)
      handle.pendingAsks.clear()
      const stop = thrown?.stoppedBy ?? outcome?.stoppedBy ?? null
      // Refused if this run no longer owns the session -- stopped and
      // replaced, or the session deleted -- so a late ending lands nowhere.
      const ending: RunEnding | null = stop
        ? {
            stoppedBy: stop,
            errorText: thrown?.errorText ?? outcome?.errorText,
          }
        : null
      useCoworkRun.getState().finishRun(sid, runId, ending)
      recordRunEnded(ending)
      // Only a run that finished on its own, and not one about to go on with
      // what was queued behind it: that one sounds when it ends.
      if (stop === 'done' && !continueWith) notifyAnswerFinished()
      // A finished run lets what was typed after its last boundary go as the
      // next request, from the effect watching the session in view. Any other
      // ending -- a failure, Stop, a cap -- holds it for the user to send or
      // discard: it was typed for a run that did not see it, and neither
      // dropping it silently nor sending it on its own is right.
      // janhq/jan#8864.
      if (stop && stop !== 'done') useMessageQueue.getState().holdQueue(sid)
      // Only after a clean finish: a stopped or failed opening run must not
      // start work on its own.
      if (continueWith && stop === 'done') {
        void runRequestRef.current(continueWith)
      }
    }
  }

  // Read through a ref so the memoized message rows keep a stable callback
  // while still calling the current render's closure.
  const runRequestRef = useRef(runRequest)
  runRequestRef.current = runRequest

  const handleSubmit = (text: string, files?: SubmittedFile[]) => {
    // Read the staged documents now: the composer clears them as soon as this
    // returns.
    const sid = session?.id
    const docs = sid
      ? useChatAttachments
          .getState()
          .getAttachments(sid)
          .filter((a) => a.type === 'document')
      : []
    const hasFiles = docs.length > 0 || (files?.length ?? 0) > 0
    const body = text.trim() || !hasFiles ? text : 'Please look at the attached file(s).'
    void runRequest(body, undefined, false, hasFiles ? { docs, files } : undefined)
  }
  // A paired phone's message to the session in view takes the same path.
  useRemoteComposer('cowork', session?.id, handleSubmit)
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
    try {
      const result = await compactHistory(cur.messages ?? [], {
        summarize: modelSummarizer({
          provider: selectedProvider,
          modelId: selectedModel.id,
          session: sid,
          maxOutputTokens: policy.summaryMaxTokens,
          window: configuredContextTokens(
            modelCapabilities,
            largestAcceptedPrompt(cur.turns)
          ),
        }),
        keepRecent: policy.keepRecent || DEFAULT_KEEP_RECENT,
        reason: 'manual',
      })
      if (!result) {
        toast.info(t('common:budget.compactFailed'))
        return
      }
      useCoworkSessions
        .getState()
        .commitTurns(
          sid,
          [{ role: 'assistant', content: '', compaction: result.record }],
          result.messages,
          [],
          undefined
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
    ],
    [t, running]
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
  }, [running, session?.id])

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

  /**
   * Queued messages belong to the session they were typed in. When the session
   * in view is idle and has one waiting it goes -- after its own run finishes,
   * or when the user returns to a session whose run finished while they were
   * elsewhere. Never dispatched into another session.
   */
  /**
   * Pending input survives a restart (janhq/jan#8864). Every change to a Cowork
   * session's queue is mirrored into the persisted session, and what the
   * session recorded comes back held -- for the user to send or discard, never
   * sent on its own. Restoring skips what is already queued, so this is
   * harmless while the app is running.
   */
  useEffect(
    () =>
      useMessageQueue.subscribe((state, prev) => {
        const store = useCoworkSessions.getState()
        for (const s of store.sessions) {
          const now = state.queues[s.id] ?? []
          if (now !== (prev.queues[s.id] ?? [])) store.setPendingInput(s.id, now)
        }
      }),
    []
  )
  const sessionsWithPending = useCoworkSessions((s) =>
    s.sessions
      .filter((x) => (x.pendingInput?.length ?? 0) > 0)
      .map((x) => x.id)
      .join(',')
  )
  useEffect(() => {
    for (const s of useCoworkSessions.getState().sessions) {
      if (s.pendingInput?.length) {
        useMessageQueue.getState().restoreHeld(s.id, s.pendingInput)
      }
    }
  }, [sessionsWithPending])

  // Mail released for an idle session in view (Automatic wake-ups) becomes
  // ready without `running` or the session changing, so the count is watched.
  const readyCount = useMessageQueue((s) =>
    session?.id ? s.getQueue(session.id).filter((m) => !m.held).length : 0
  )
  const idleDrainRef = useRef(false)
  useEffect(() => {
    if (running || !session?.id || idleDrainRef.current) return
    // Held input waits for the user; only what is ready goes. Mail is claimed
    // first, so a reply a tool already consumed is not sent again.
    idleDrainRef.current = true
    // The message is sent only into the session it was drained from; see
    // drainIdleSession.
    void drainIdleSession(session.id, (text, from) => {
      void runRequestRef.current(text, from)
    })
      .then(() => {
        idleDrainRef.current = false
      })
      .catch(() => {
        idleDrainRef.current = false
      })
  }, [running, session?.id, readyCount])

  /**
   * Where the transcript was scrolled to, kept across a trip to Settings.
   *
   * The scroll node is the one `StickToBottom` owns inside the `role="log"`
   * container; it is found rather than held by ref because that element is the
   * library's, not this route's. It is looked for inside this page's own
   * transcript only: in split view each pane has one.
   */
  const scrollNode = useCallback((): HTMLElement | null => {
    const log = transcriptRef.current?.querySelector('[role="log"]')
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
  }, [session?.id, scrollNode])
  // Remembered in a layout cleanup: it runs while the transcript is still
  // attached, on a session switch and when the page unmounts (leaving for
  // Settings, closing a pane). A passive cleanup ran after the ref was
  // detached, so an unmount remembered nothing.
  useLayoutEffect(() => {
    const sid = session?.id
    if (!sid) return
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
    return addSnapshotSink((sessionId, ref) => {
      // Kept for the step that follows: the accounting for a dispatch is only
      // known once its reply lands, and by then the sink has moved on.
      lastSnapshotRef.current[sessionId] = ref
      // AH-032: the record links this request to the exact payload it sent,
      // the same way the agent loop does, so a finished run can be replayed
      // from the record rather than from a reconstruction of it. Recorded
      // under the run that is dispatching, never the session in view.
      const running = useCoworkRun.getState().runs[sessionId]?.runId
      if (running) {
        void recordEvents([
          {
            id: `dispatch:${ref.invocation || ref.id}`,
            session: sessionId,
            run: running,
            invocation: ref.invocation ?? '',
            kind: 'message.completed',
            payload: {
              phase: 'dispatched',
              snapshotId: ref.id,
              hash: ref.hash,
              redactions: ref.redactions,
            },
          },
        ])
      }
      // Beside the turns, not on them: the run rebuilds its live turn array as
      // steps complete, so a reference written onto a turn at dispatch time is
      // gone before it can render.
      useCoworkRun.getState().recordPromptSnapshot(sessionId, ref)
    })
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
  }, [pendingPreview, session?.id, setRail])

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
  }, [pendingCodeOpen, session?.id, openToolPath, setRail])

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
  }, [session?.id, setRail])

  // Layout. Wide windows dock the output panel beside the conversation; below
  // 1100px it becomes a drawer over the conversation's right edge; below 768px
  // Cowork shows one view at a time -- the conversation, the output, or the
  // session details -- chosen from the context bar. The conversation stays
  // mounted while hidden, so the composer keeps its draft, and its scroll
  // position is put back on return.
  // In a split-view pane the pane's width decides, not the window's.
  const paneWidth = usePaneWidth()
  // In a split pane this page draws the pane's one header row: title, its
  // own controls and the pane's, instead of the shell header's context bar,
  // the phone view row and the conversation frame's title row.
  const paneChrome = usePaneChrome()
  // Narrow panes switch views by icon; wider ones spell the views out.
  const compactViews = paneWidth != null && paneWidth < 520
  const windowNarrow = useMediaQuery('(max-width: 1099px)')
  const windowPhone = useMediaQuery('(max-width: 767px)')
  const narrow = paneWidth != null ? paneWidth < 1100 : windowNarrow
  const phone = paneWidth != null ? paneWidth < 768 : windowPhone
  const [phoneView, setPhoneView] = useState<CoworkPhoneView>('content')
  const view: CoworkPhoneView = phone ? phoneView : 'content'
  const transcriptScroll = useRef<number | null>(null)
  const showView = useCallback(
    (next: CoworkPhoneView) => {
      if (phoneView === 'content' && next !== 'content') {
        const node = scrollNode()
        transcriptScroll.current = node ? node.scrollTop : null
      }
      setPhoneView(next)
    },
    [phoneView, scrollNode]
  )
  useEffect(() => {
    if (view !== 'content' || transcriptScroll.current == null) return
    const top = transcriptScroll.current
    transcriptScroll.current = null
    requestAnimationFrame(() => {
      const node = scrollNode()
      if (node) node.scrollTop = top
    })
  }, [view, scrollNode])

  // On a phone, an explicit request to see output also shows the output view.
  // Automatic opens (an artifact finishing) change the tab but not the view.
  const revealOutput = useCallback(() => {
    if (phone) showView('output')
  }, [phone, showView])
  const openRail = useCallback(
    (next: CoworkRail) => {
      setRail(next)
      revealOutput()
    },
    [setRail, revealOutput]
  )
  const closeRail = useCallback(() => {
    setRail(null)
    if (phone) showView('content')
  }, [setRail, phone, showView])
  const selectRailInView = useCallback(
    (next: RailMode) => {
      selectRail(next)
      revealOutput()
    },
    [selectRail, revealOutput]
  )
  // Code and Timeline describe a session, so neither renders without one.
  const panelShown =
    rail != null &&
    (rail.kind === 'preview' ||
      rail.kind === 'diff' ||
      rail.kind === 'tasks' ||
      Boolean(session?.id))
  const inspectorLayout: InspectorLayout = phone
    ? 'full'
    : narrow
      ? 'drawer'
      : 'docked'
  const inspectorVisible = phone ? view === 'output' : panelShown
  // The output panel's buttons in the composer row are a setting, off by
  // default for a quieter composer; without them one header button opens and
  // closes the panel on the tab last used.
  const showComposerRailButtons = useInterfaceSettings(
    (st) => st.showComposerRailButtons
  )
  const lastRail = useRef<RailMode>('changes')
  if (activeRail) lastRail.current = activeRail
  const outputToggle = (
    <Button
      variant="outline"
      size="sm"
      className="h-[30px] shrink-0 pointer-coarse:h-11"
      aria-pressed={panelShown}
      aria-label={t('common:coworkLayout.output')}
      data-testid="cowork-output-toggle"
      onClick={() =>
        panelShown ? closeRail() : selectRailInView(lastRail.current)
      }
    >
      <PanelRight className="size-4" aria-hidden />
      <span className="max-sm:sr-only">{t('common:coworkLayout.output')}</span>
    </Button>
  )
  // The rail buttons stay in the composer row whether or not the output panel
  // is open, so opening it never takes controls away from where they were;
  // the panel header carries the same buttons as its tabs. Both sets share
  // names and `aria-pressed`, so the smoke harness's first match is right.
  const railToolbar = (presentation: 'toolbar' | 'tabs') => (
    <CoworkRailToolbar
      presentation={presentation}
      active={activeRail}
      onSelect={selectRailInView}
      changeCount={changeCounts.fileCount}
      additions={changeCounts.additions}
      deletions={changeCounts.deletions}
      changeSummary={formatChangeSummary(changeCounts)}
      activity={taskCounts}
    />
  )

  // The session's own model (janhq/jan#8905): keyed by session so switching
  // re-reads it, and a choice is written to the session in view only.
  const modelSelector = (
    <DropdownModelProvider
      key={session?.id ?? 'none'}
      model={session?.model}
      useLastUsedModel={!session?.model}
      onModelChange={(model) =>
        useCoworkSessions
          .getState()
          .setModel(ensureCurrentSession(paneSessionIdRef.current), {
          provider: model.provider,
          id: model.id,
        })
      }
    />
  )

  // The session's own model (janhq/jan#8905): keyed by session so switching
  // re-reads it, and a choice is written to the session in view only.
  const quietModelSelector = (
    <DropdownModelProvider
      variant="quiet"
      key={session?.id ?? 'none'}
      model={session?.model}
      useLastUsedModel={!session?.model}
      onModelChange={(model) =>
        useCoworkSessions
          .getState()
          .setModel(ensureCurrentSession(paneSessionIdRef.current), {
          provider: model.provider,
          id: model.id,
        })
      }
    />
  )

  // Mode, access and workspace: in the context bar on wide screens, in the
  // composer row on phones where the bar holds the view switch.
  const workProfilesOn = useWorkProfiles((st) => st.enabled)
  const workProfileChoice = useWorkProfiles((st) =>
    session?.id ? st.sessions[session.id] : undefined
  )
  // AH-209: a folder with no FLINT.md is offered a starting one, from the
  // folder menu. Offered only when FLINT.md is known to be absent; one that
  // could not be read is still there, and is not overwritten.
  const projectInitRoot = treeRoot ?? null
  const projectInitOffered =
    Boolean(projectInitRoot) &&
    instructionFiles.some(
      (file) => file.role === 'native' && file.state.kind === 'missing'
    )
  const hasProjectInitDraft = useProjectInitDrafts((st) =>
    projectInitRoot ? st.draftFor(projectInitRoot) !== null : false
  )
  // The project folder: in the header on wide screens, in the composer row
  // on phones and in panes.
  const workspacePill = (
    <>
      <CoworkWorkspacePill
        describeProject={
          projectInitOffered
            ? {
                label: projectInitLabel(hasProjectInitDraft),
                onOpen: () => setProjectInitOpen(true),
              }
            : undefined
        }
        folder={folder}
        workspacePath={workspacePath}
        gitBranch={gitBranch}
        onAttach={() => void attachFolder()}
        onDetach={detachFolder}
        access={effective.access}
        extraFolders={extraFolders}
        extraFoldersWritable={
          capabilityState.known && capabilityState.directEdit
        }
        onAddExtra={() => void addExtraFolder()}
        onRemoveExtra={(extra) => void removeExtraFolder(extra)}
      />
    </>
  )

  // What the run may do and how it works: under the composer, as quiet
  // one-word buttons (Claude's layout), and as pills in a pane's composer row.
  const runControls = (variant: 'pill' | 'quiet') => (
    <>
      <CoworkModeSelector
        variant={variant}
        mode={mode}
        // A choice made before the first message still needs a session to
        // live on; dropping it left the session in its default mode while the
        // user believed they had picked another.
        onChange={(next) =>
          useCoworkSessions
            .getState()
            .setMode(ensureCurrentSession(paneSessionIdRef.current), next)
        }
      />
      <CoworkAccessSelector
        variant={variant}
        effective={effective}
        capability={capabilityState}
        hasFolder={Boolean(folder)}
        // Authority must not move under work already running. A background
        // shell job outlives its run and can still write, so it holds
        // authority in place just as a live turn does.
        busyReason={null}
        onRequestDirectEdit={() => setConfirmDirectEdit(true)}
        onRequestWorktree={() => {
          if (!session?.id) return
          if (running || blockingKind)
            setPendingAccess((pending) => ({ ...pending, [session.id]: 'managed-worktree' }))
          else void authorizeManagedWorktree()
        }}
        onReviewOnly={() => {
          if (!session?.id) return
          if (running || blockingKind)
            setPendingAccess((pending) => ({ ...pending, [session.id]: 'review-only' }))
          else void returnToReviewOnly()
        }}
      />
      {workProfilesOn && session?.id && (
        <CoworkWorkProfilePicker
          variant={variant}
          choice={workProfileChoice}
          onChoose={(id) => useWorkProfiles.getState().choose(session.id, id, true)}
          onAuto={() => useWorkProfiles.getState().clearManual(session.id)}
        />
      )}
    </>
  )

  const sessionControls = (
    <>
      {workspacePill}
      {runControls('pill')}
    </>
  )

  // Everything about the session that is reference material rather than
  // conversation: behind a dialog on wide screens, a view of its own on phones.
  const detailsBody = (
    <>
      <CoworkReadinessCard
        manifest={readiness}
        settingsMcpServers={settingsMcpServers}
        modelTest={
          <ModelDoctor
            provider={selectedProvider ? getProviderByName(selectedProvider) : undefined}
            model={selectedModel ?? undefined}
          />
        }
      />
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
      <CoworkEnvironmentReadiness
        projectRoot={folder ?? undefined}
        reported={rendererReports}
        collapsible
      />
      {runContext && <CoworkContextBreakdown context={runContext} />}
      <CoworkCompatSection
        manifest={compat}
        hasFolder={Boolean(folder)}
        onToggle={(on) =>
          folder && useClaudeCompat.getState().setEnabled(folder, on)
        }
        // Drives Flint's own MCP subsystem, against the definition as it
        // stands on disk: consent is permission to run *this* server,
        // not whatever the file says later.
        onMcpConsent={(server, allowed) => {
          const probe = mcpProbes.find((one) => one.name === server)
          if (probe) void setMcpConsent(probe, allowed)
        }}
      />
      <ClaudeSkillRootsSettings
        collapsible
        roots={skillRoots}
        onChange={(next) => useClaudeCompat.getState().setSkillRoots(next)}
        janData={janDataFolder}
        onRescan={rescanCompat}
        pickFolder={async () => {
          const picked = await serviceHub.dialog().open({ directory: true })
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
    </>
  )

  const runningChip = running ? (
    <Chip className="border-transparent bg-transparent text-secondary-foreground">
      <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
      {/* Icon only on a phone or in a pane, where the title needs the room. */}
      <span className={paneChrome ? 'sr-only' : 'max-md:sr-only'}>
        {t('common:coworkLayout.running')}
      </span>
    </Chip>
  ) : null

  // An unpinned plan stays one click away in the header.
  const progressButton =
    session?.progressUi?.unpinned ? (
      <CoworkProgressButton
        todos={session.todos}
        compact={Boolean(paneChrome)}
        onPin={() =>
          useCoworkSessions
            .getState()
            .setProgressUi(session.id, { unpinned: false })
        }
      />
    ) : null

  // One view at a time on a phone (or a phone-width pane), chosen here rather
  // than by swiping, so every view is reachable from the keyboard too. In a
  // pane it is a compact segmented control in the pane's header, icons only
  // when the pane is narrow.
  const viewIcon = {
    content: MessageSquare,
    output: PanelRight,
    details: Info,
  } as const
  const viewSwitch = (compact: boolean) => (
    <div
      role="group"
      aria-label={t('common:coworkLayout.views')}
      data-testid="cowork-view-switch"
      className={cn(
        'flex min-w-0 items-stretch overflow-hidden bg-muted shadow-[inset_0_0_0_0.8px_var(--border)]',
        paneChrome
          ? 'h-7 shrink-0 gap-0.5 rounded-lg p-0.5 pointer-coarse:h-11'
          : 'h-9 flex-1 gap-1 rounded-[10px] p-1 pointer-coarse:h-11'
      )}
    >
      {PHONE_VIEWS.map((option) => {
        const label = t(`common:coworkLayout.${option}`)
        const ViewIcon = viewIcon[option]
        return (
          <button
            key={option}
            type="button"
            aria-pressed={view === option}
            aria-label={compact ? label : undefined}
            title={compact ? label : undefined}
            data-testid={`cowork-view-${option}`}
            onClick={() => showView(option)}
            className={cn(
              'flex min-w-0 items-center justify-center rounded-md font-medium outline-none transition-[background-color,color,box-shadow] duration-150 ease-expo focus-visible:ring-[3px] focus-visible:ring-ring/40',
              paneChrome ? 'px-2 text-xs' : 'flex-1 px-2 text-[12.5px]',
              compact && 'w-7 px-0',
              view === option
                ? 'bg-card text-foreground shadow-lift'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {compact ? (
              <ViewIcon className="size-3.5" aria-hidden />
            ) : (
              <span className="truncate">{label}</span>
            )}
          </button>
        )
      })}
    </div>
  )

  // The composer's stop control is out of sight in the other phone views, so
  // a running session can still be stopped from the header.
  const headerStop =
    phone && running && view !== 'content' ? (
      <Button
        variant="destructive"
        size="sm"
        className={cn('shrink-0 pointer-coarse:h-11', paneChrome && 'h-7')}
        onClick={handleStop}
        data-testid="cowork-header-stop"
      >
        {t('common:stop')}
      </Button>
    ) : null

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {paneChrome ? (
        <PaneHeaderBar
          paneId={paneChrome.paneId}
          isActive={paneChrome.isActive}
          title={session?.title || t('common:newSession')}
          controls={paneChrome.controls}
        >
          {runningChip}
          {progressButton}
          {headerStop}
          {!phone && !showComposerRailButtons && outputToggle}
          {/* No context bar in a pane: each pane picks its own session's
              model here, never the global one. */}
          <div
            className="flex min-w-20 max-w-48 shrink"
            data-testid={`cowork-pane-model-${paneChrome.paneId}`}
          >
            {modelSelector}
          </div>
          {phone ? (
            viewSwitch(compactViews)
          ) : (
            <CoworkSessionDetails summary={sessionDetailsSummary}>
              {detailsBody}
            </CoworkSessionDetails>
          )}
        </PaneHeaderBar>
      ) : (
      <HeaderPage>
        {/* The same row component the chat page uses, so the selector and the
            control beside it match in size, spacing and order. The session's
            title is not repeated here: it heads the conversation frame. */}
        <PageHeaderRow>
          {!phone && (
            // Set off from the breadcrumb by a dashed rule: the project folder,
            // which truncates its name when the row is tight. The run's own
            // controls and the model sit under the composer.
            <div
              data-testid="cowork-context-bar"
              className="@container/ctx flex min-w-0 flex-1 items-center gap-2 overflow-hidden border-l border-dashed border-border pl-3.5"
            >
              {workspacePill}
              {runningChip}
              {progressButton}
            </div>
          )}
          {!phone && (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {!showComposerRailButtons && outputToggle}
              {!coworkPane && <SplitToggleButton />}
              {/* Closed until asked for. */}
              <CoworkSessionDetails summary={sessionDetailsSummary}>
                {detailsBody}
              </CoworkSessionDetails>
            </div>
          )}
        </PageHeaderRow>
      </HeaderPage>
      )}

      {phone && !paneChrome && (
        // On a phone the header has no room beside the breadcrumb, so the
        // view switch -- and Stop, while the composer is out of sight -- get a
        // row of their own over the page.
        <div className="flex shrink-0 items-center gap-2 pt-2 pb-2">
          {viewSwitch(false)}
          {headerStop}
        </div>
      )}
      <CoworkInspectorProvider layout={inspectorLayout}>
      {/* Two framed cards side by side, as the design lays out Cowork: the
          conversation, and the output panel once one is open. */}
      <div
        className={cn(
          'relative flex h-full min-h-0 flex-1 overflow-hidden',
          // A pane sits flush under its header; the split gives the room.
          paneChrome
            ? phone
              ? 'gap-0'
              : 'gap-4'
            : phone
              ? 'gap-0 pb-2'
              : 'gap-4 px-1 pt-3.5 pb-4'
        )}
      >
        <Frame
          className={cn(
            'h-full min-h-0 flex-1 motion-safe:animate-rise-in',
            view !== 'content' && 'hidden',
            paneChrome?.isActive && ACTIVE_PANE_RING
          )}
          data-testid="cowork-content-view"
        >
          {/* No title row: the title is the breadcrumb's, and the run's
              state sits beside it in the header. */}
          <FrameBody className="min-h-0 overflow-hidden">
          {/* The live plan, pinned over the transcript so it never scrolls
              away. */}
          {session && !session.progressUi?.unpinned ? (
            <CoworkPinnedProgress
              todos={session.todos}
              expanded={Boolean(session.progressUi?.expanded)}
              onToggle={() =>
                useCoworkSessions.getState().setProgressUi(session.id, {
                  expanded: !session.progressUi?.expanded,
                })
              }
              onUnpin={() =>
                useCoworkSessions
                  .getState()
                  .setProgressUi(session.id, { unpinned: true })
              }
            />
          ) : null}
          <div ref={transcriptRef} className="relative flex-1">
            {displayedTurns.length === 0 ? (
              <CoworkEmptyState
                folder={folder}
                onPick={(text) => usePrompt.getState().setPrompt(text)}
              />
            ) : (
              <Conversation className="absolute inset-0 text-start">
                <ConversationContent className="transcript-list mx-auto w-full max-w-[756px] px-[18px] pt-4 pb-3">
                  <CodeOpenProvider
            open={openToolPath}
            check={checkToolPath}
            openDiff={openToolDiff}
            displayPath={displayToolPath}
            roots={pathLinkRoots}
          >
                    {windowStart > 0 && (
                      <div className="flex justify-center pb-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid="show-earlier-messages"
                          className="text-muted-foreground"
                          onClick={() =>
                            setEarlierShown({
                              sid: session?.id ?? null,
                              pages: earlierPages + 1,
                            })
                          }
                        >
                          {t('common:coworkShowEarlier', {
                            count:
                              windowStart -
                              transcriptWindowStart(messageWeights, earlierPages + 1),
                          })}
                        </Button>
                      </div>
                    )}
                    {uiMessages.slice(windowStart).map((whole, shownAt) => {
                      const i = shownAt + windowStart
                      // Each model round renders with its own rows beneath
                      // it, so the newest content is always last.
                      const segments = segmentAssistantMessage(whole)
                      const workflow = workflowAnchoredAt(
                        activity,
                        session?.id,
                        whole.id
                      )
                      const workflowAt = workflow
                        ? workflowSegmentIndex(
                            segments,
                            workflow.tasks.map((task) => task.callId)
                          )
                        : -1
                      return segments.map((message, k) => (
                      <Fragment key={message.id}>
                        <MessageItem
                          message={message}
                          isFirstMessage={i === 0 && k === 0}
                          switchedFrom={
                            k === 0 ? switchedFromOf(uiMessages, i) : undefined
                          }
                          isLastMessage={
                            i === uiMessages.length - 1 &&
                            k === segments.length - 1
                          }
                          hideActions={k < segments.length - 1 || undefined}
                          continuation={k > 0 || undefined}
                          midReply={k < segments.length - 1 || undefined}
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
                        {/* The plan as this run left it, after its prompt. */}
                        {k === segments.length - 1 &&
                        snapshotByAnchor.has(whole.id) ? (
                          <CoworkPlanStrip
                            todos={snapshotByAnchor.get(whole.id)}
                            defaultOpen={false}
                            snapshot
                          />
                        ) : null}
                        {/* One card per workflow, at the message its first
                        dispatch landed under. Same store as the panel, so it
                        is live without a copy of anything. */}
                        {(() => {
                          const view = k === workflowAt ? workflow : null
                          return view ? (
                            <CoworkWorkflowCard
                              view={view}
                              now={activityNow}
                              onOpenTask={(task) => {
                                showTaskInPanel(task)
                                revealOutput()
                              }}
                              onOpenPanel={(workflowId) => {
                                showWorkflowInPanel(workflowId)
                                revealOutput()
                              }}
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
                                plan={session?.todos}
                              />
                            )
                          })}
                        {/* The conversation was compacted here. */}
                        {(message.parts as { type: string; data?: unknown }[])
                          .filter((p) => p.type === 'data-compaction')
                          .map((p) => {
                            const record = p.data as CompactionRecord
                            return (
                              <CompactionDivider
                                key={`compaction-${record.at}`}
                                record={record}
                              />
                            )
                          })}
                        {/* Another session stopped this run, with its user's
                        approval: who, and the reason it gave. */}
                        {(message.parts as { type: string; data?: unknown }[])
                          .filter((p) => p.type === 'data-session-stop')
                          .map((p) => {
                            const notice = p.data as SessionStopNoticeData
                            return (
                              <SessionStopNotice
                                key={notice.requestId}
                                notice={notice}
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
                          return ref && showPromptSnapshot ? (
                            <PromptSnapshotView
                              snapshotId={ref.id}
                              sessionId={session?.id}
                            />
                          ) : null
                        })()}
                        {/* This turn's own token breakdown and the memory ids
                        its request carried (AH-211, AH-083). */}
                        {(() => {
                          const data = (
                            message.parts as { type: string; data?: unknown }[]
                          ).find((part) => part.type === 'data-turn-usage')
                            ?.data as
                            | { usage?: Usage; memory?: TurnMemory }
                            | undefined
                          return data && showPromptSnapshot ? (
                            <TurnUsageDetails
                              usage={fromCoworkUsage(data.usage)}
                              memory={data.memory}
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
                            onPreview={(path) => {
                              showPreview(path)
                              revealOutput()
                            }}
                          />
                        ))}
                      </Fragment>
                                          ))
                    })}
                  </CodeOpenProvider>
                  {/* AH-109: overlapping team tasks, before either runs. */}
                  <CoworkTeamConflicts sessionId={session?.id} />
                  <CoworkChildApprovals sessionId={session?.id} />
                  {/* Once the run has ended: while it goes, the header says
                      Running and Changes shows its files, and a card growing
                      under the transcript said it a third time. */}
                  {(((!running && (runEnding || runOrigins?.summary)) &&
                    // Only when the run has something of its own to report:
                    // a write, a check, a loose end, or an ending that was
                    // not a clean finish. A working tree that was already
                    // dirty is not the run's work, and reporting it here left
                    // a permanent panel over the composer listing the user's
                    // own edits. The stop reason itself stays in the notice
                    // below; this shows what was kept.
                    shouldShowRunOutcome(runOutcome)) ||
                    // A browser verification is evidence the user asked
                    // for; it is shown even after a run with nothing else.
                    browserReports.length > 0) && (
                      <CoworkRunSummary
                        outcome={runOutcome}
                        browserChecks={browserReports}
                        canOpenPath={shouldOpenInCode}
                        onOpenPath={
                          runOutcome.resultLocation.destination ===
                            'repository' && treeRoot
                            ? (path) => openToolPath(`${treeRoot}/${path}`)
                            : runOutcome.resultLocation.destination ===
                                'sandbox'
                              ? openToolPath
                              : undefined
                        }
                        onReviewChanges={() => openRail({ kind: 'diff' })}
                        onRestore={() => openRail({ kind: 'diff' })}
                        onRetry={() => void runRequest(null)}
                        // A follow-up run under the session's current mode,
                        // asked to retry what this one left unresolved.
                        // Focusing the composer did nothing visible. The
                        // request is Flint's, so it is not drawn as a user
                        // message.
                        onContinue={() =>
                          void runRequest(
                            continueRequest(runOutcome.unresolved),
                            undefined,
                            true
                          )
                        }
                      />
                    )}
                  {running && (
                    // Row wrapper as in the chat route: the transcript is a
                    // column flex, which stretches the indicator's own
                    // `inline-flex` box across the whole column.
                    <div className="flex flex-row items-center gap-2">
                      <PromptProgress
                        hideIdle={!awaitingModel}
                        stateKey={session?.id}
                        status={runStatusNow}
                      />
                    </div>
                  )}
                  {memoryProposalLocation && (
                    <MemoryProposalList
                      className="my-2"
                      proposals={memoryProposals}
                      location={memoryProposalLocation}
                      onResolved={onMemoryProposalResolved}
                      onOpenSettings={() =>
                        navigateTo({ to: route.settings.memory })
                      }
                    />
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
                  {session?.id ? (
                    <CoworkInterruptedTurn
                      sessionId={session.id}
                      running={running}
                      onContinue={() => void runRequestRef.current(null)}
                    />
                  ) : null}
                  {session?.id ? (
                    <CoworkHeldInput sessionId={session.id} running={running} />
                  ) : null}
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
                      // An overflow carries its measurement; the spend cap
                      // stops with none.
                      cause={runError ? 'window' : 'budget'}
                      detail={runError ?? undefined}
                      // Compacts the session's history for real, then
                      // resumes the run on the room that freed.
                      onCompact={() =>
                        void compactNow({ thenContinue: true })
                      }
                      compacting={compacting}
                      onNewSession={() => {
                        // Same rule as the sidebar's entry point: one press,
                        // at most one session. An unsent draft is parked on
                        // the session being left (held input) when it has
                        // content, so the new one opens blank.
                        const paneId = sidePaneIdRef.current
                        const paneSid = paneSessionIdRef.current
                        const prompts = usePrompt.getState()
                        const scope = coworkPane?.draftScope
                        if (paneId && paneSid && scope) {
                          // From a pane beside the main one: judged on that
                          // pane's session and draft, opened in that pane.
                          const { id, parked } = startPaneSessionParked(paneSid, {
                            running,
                            draft: prompts.scoped[scope]?.prompt,
                          })
                          useSplitConversation
                            .getState()
                            .setPaneTarget(paneId, { kind: 'cowork', refId: id })
                          if (parked) prompts.setScopedPrompt(scope, '')
                          return
                        }
                        const store = useCoworkSessions.getState()
                        const { id, parked } = store.startSessionParked({
                          running,
                          draft: prompts.prompt,
                        })
                        store.selectSession(id)
                        // Cleared here, not in the store, and only when parked:
                        // otherwise the draft would be lost.
                        if (parked) prompts.resetPrompt()
                      }}
                    />
                  )}
                  {compacting && <CompactingIndicator />}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>
            )}
          </div>

          <div className={cn('shrink-0 px-3.5 pt-2', paneChrome ? 'pb-3.5' : 'pb-1.5')}>
            <div className="mx-auto w-full max-w-[780px]">
              {/* Work a crashed or closed run left behind. Shown where the
                  session is about to start, because that is the moment someone
                  would otherwise start a second one beside it. Everything else
                  that used to sit here -- readiness, compatibility, skill
                  folders, context accounting -- moved behind the session
                  details control in the header, so the composer sits directly
                  beneath the conversation. */}
              {/* Not beside the session's own worktree bar: a session that
                  already has a worktree is not about to adopt another. */}
              {/* The bars over the composer stack: two at a time, the rest
                  behind "Show N more". */}
              <CoworkBarStack>
                {folder &&
                  !recoveryHiddenHere &&
                  ((!worktree && (session?.turns.length ?? 0) === 0) ||
                    effective.downgradedFrom === 'managed-worktree') && (
                  <div className="px-1 pb-2">
                    <CoworkWorktreeRecovery
                      orphans={recoverableWorktrees(
                        foundWorktrees,
                        worktree,
                        session?.id,
                        coworkSessionIds,
                        heldWorktreePaths
                      )}
                      onHide={() => {
                        hideRecovery(folder)
                        setRecoveryHiddenHere(true)
                      }}
                      ownBranch={
                        session?.id ? sessionWorktreeBranch(session.id) : undefined
                      }
                      downgradeNote={(() => {
                        const key = effectiveDowngradeKey(effective)
                        return key &&
                          effective.downgradedFrom === 'managed-worktree'
                          ? t(key)
                          : undefined
                      })()}
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
                {/* The session's changed files, one step from review: over the
                    composer, where the design keeps it while the run goes on. */}
                <CoworkReviewReady
                  fileCount={changeCounts.fileCount}
                  additions={changeCounts.additions}
                  deletions={changeCounts.deletions}
                  onReview={() => openRail({ kind: 'diff' })}
                  sessionId={session?.id}
                  running={running}
                  sandboxPaths={fileDiffs.map((f) => f.path)}
                  applyActions={sandboxApply}
                />
                {/* The pull request for the folder's branch, if it has one, with
                    the same mark the session carries in the sidebar. */}
                {session?.id && folder ? (
                  <CoworkSessionWorktreeBar
                    sessionId={session.id}
                    title={session.title}
                    folder={folder}
                    record={worktree}
                    offerCopy={
                      autoWorktree.isGit === false &&
                      capabilityState.known &&
                      capabilityState.managedWorktree &&
                      (session.turns.length ?? 0) === 0
                    }
                    onWorkOnCopy={autoWorktree.workOnCopy}
                    onCreatePr={(branch, base) =>
                      handleSubmit(
                        t('common:coworkParallel.prPrompt', {
                          branch,
                          base: base || 'the default branch',
                        })
                      )
                    }
                    onDiscarded={() => {
                      const sid = session.id
                      void useDirectEditGrants.getState().revokeSession(sid)
                      useCoworkWorktrees.getState().forget(sid)
                      useCoworkSessions.getState().setAccess(sid, 'review-only')
                      useCoworkParallel.getState().mark(sid, folder, 'skipped')
                    }}
                  />
                ) : null}
                <PrBar folder={treeRoot ?? folder} sessionId={session?.id} className="mb-2" />
              </CoworkBarStack>
              {/* The FLINT.md dialog; the folder menu opens it. */}
              <CoworkProjectInit
                hideTrigger
                open={projectInitOpen}
                onOpenChange={setProjectInitOpen}
                folder={projectInitRoot}
                hasInstructions={!projectInitOffered}
                onAccepted={() => setInstructionsVersion((v) => v + 1)}
              />
              {/* Jev: a suggested skill, only when its opt-in is on. */}
              <JevSkillSuggestion
                surface="cowork"
                project={folder}
                draftScope={coworkPane?.draftScope}
              />
              <ChatInput
                showSpeedToken={false}
                initialMessage={true}
                scopeKey={session?.id}
                draftScope={coworkPane?.draftScope}
                // The session's model, resolved as the run resolves it: the
                // composer must not refuse a send the run would make.
                modelSelection={composerModel.selection}
                // The session's own effort, where its transport reads it.
                modelOverrideScope={session?.id ?? ''}
                unavailableModel={composerModel.unavailable}
                confirmModel={confirmSessionModel}
                // Held input is shown once, in CoworkHeldInput above.
                heldShownElsewhere
                ownsToolSet={false}
                // `@` names files in the folder the run works in, nothing else.
                referenceRoot={treeRoot}
                referenceSources={referenceSources}
                slashSurface="cowork"
                slashProject={folder}
                slashBuiltins={slashBuiltins}
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
                    runId={currentRunId}
                    onStopCurrent={handleStop}
                    onStopAll={handleStopAll}
                  />
                }
                tokenSource={tokenSource}
                onCompact={() => void compactNowRef.current()}
                // Assistant, sampling, web search and reasoning behind one
                // Options button: the Cowork row stays quiet.
                groupOptions
                // Under the composer, as Claude lays it out: what the run may
                // do on the left; the effort and the model on the right.
                belowLeft={!paneChrome ? runControls('quiet') : undefined}
                modelControl={!paneChrome ? quietModelSelector : undefined}
                surfaceControls={
                  <>
                    {paneChrome ? sessionControls : phone ? workspacePill : null}
                    <CoworkSandboxChip />
                    {/* On a phone the composer is out of view while the
                        output is, so it keeps one set there. */}
                    {showComposerRailButtons &&
                      (!phone || !inspectorVisible) &&
                      railToolbar('toolbar')}
                    <div className="ml-auto flex items-center">
                      <SkillSelector folder={folder} />
                    </div>
                  </>
                }
              />
            </div>
          </div>
          </FrameBody>
        </Frame>

        {view === 'details' && (
          <div
            className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-1 py-3"
            data-testid="cowork-details-view"
          >
            <Button
              variant="ghost"
              size="sm"
              className="self-start pointer-coarse:h-11"
              onClick={() => showView('content')}
            >
              <ArrowLeft className="size-4" aria-hidden />
              {t('common:coworkLayout.back')}
            </Button>
            <CoworkSessionDetails inline summary={sessionDetailsSummary}>
              {detailsBody}
            </CoworkSessionDetails>
          </div>
        )}

        {inspectorVisible && (
          <CoworkInspectorFrame
            tabs={railToolbar('tabs')}
            onBack={() => showView('content')}
            onDismiss={closeRail}
          >
        {rail?.kind === 'preview' && (
          <CoworkPreviewPanel
            root={workspacePath}
            path={rail.path}
            onClose={closeRail}
            verify={session?.id ? <BrowserVerifyPanel sessionId={session.id} /> : undefined}
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
              </>
            }
            // After the files, as the design orders it: what each turn
            // changed, earlier points, then bundles made elsewhere.
            footer={
              <>
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
                  session?.id && checkpointChain
                    ? useCoworkCheckpoints
                        .getState()
                        .usable(session.id, treeRoot)
                    : []
                }
                onPlan={(sha) =>
                  useCoworkCheckpoints.getState().plan(session?.id ?? '', sha)
                }
                onPreviewDiff={(sha) =>
                  useCoworkCheckpoints
                    .getState()
                    .previewDiff(session?.id ?? '', sha)
                }
                // Newer edits Flint made itself are not someone else's work, so
                // only the rest need an explicit acknowledgement.
                janAuthored={
                  runOrigins?.summary ? janAuthoredPaths(runOrigins.summary) : []
                }
                onSafetyCapture={async (label) => {
                  if (!session?.id || !treeRoot)
                    return { ok: false, reason: 'no working tree' }
                  const saved = await useCoworkCheckpoints
                    .getState()
                    .captureSafety({
                      sessionId: session.id,
                      root: treeRoot,
                      label,
                      access: effective.access,
                    })
                  return saved.ok
                    ? { ok: true, point: saved.entry }
                    : saved
                }}
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
              </>
            }
            branch={worktree?.branch ?? gitBranch}
            projectName={folder ? basenameOf(folder) : undefined}
            sandboxFiles={fileDiffs}
            onOpenFile={openToolPath}
            // Review only leaves the run's output in the sandbox; this is the
            // explicit per-file step that brings one file into the folder.
            // The primary and every extra folder the session holds.
            isSandboxPath={(path) =>
              sandboxRelativePath(workspacePath, path) !== null
            }
            applyPlanFor={(path) =>
              planSandboxApply(workspacePath, applyFolders, path)
            }
            onApplyFile={sandboxApply?.apply}
            applyActions={sandboxApply}
            displayPath={displayToolPath}
            onOpenExternal={(path, source) => {
              const absolute = absoluteChangePath(path, source, {
                treeRoot,
                workspacePath,
                resolved: resolveToolPath(path),
              })
              if (!absolute) return
              void serviceHub
                .opener()
                .openPath(absolute)
                .catch((e) => toast.error(errorText(e)))
            }}
            // The tree the changes are in, not the one the session is
            // attached to: a managed run's diff lives in its worktree.
            folder={treeRoot}
            git={git}
            origins={runOrigins?.entries}
            focusPath={rail.focusPath}
            onClose={closeRail}
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
            onClose={closeRail}
          />
        )}
        {rail?.kind === 'timeline' && session?.id && (
          <CoworkTimelinePanel
            sessionId={session.id}
            running={running}
            onClose={closeRail}
          />
        )}
        {rail?.kind === 'code' && session?.id && (
          <CoworkCodePanel
            onOfferFolder={() => void attachFolder()}
            // The tree the run reads. Browsing the attached folder while the
            // agent works in a worktree would show two different repositories
            // under one name.
            folder={treeRoot}
            projectName={folder ? basenameOf(folder) : undefined}
            workspacePath={workspacePath}
            sessionKey={session.id}
            state={session.codePanel}
            turns={displayedTurns}
            onStateChange={(next) =>
              useCoworkSessions.getState().setCodePanel(session.id, next)
            }
            onAddToChat={addCodeToChat}
            onAttach={() => void attachFolder()}
            onClose={closeRail}
            // A Review only run's copy of a project file shows as markers on
            // the real one, found the way Apply to folder maps it.
            sandboxCopyFor={(projectPath) =>
              sandboxApply
                ? (sandboxCopyOfProjectFile(
                    fileDiffs.map((f) => f.path),
                    sandboxApply.planFor,
                    folder,
                    projectPath
                  )?.plan.source ?? null)
                : null
            }
            onApplySandboxHunk={async (projectPath, expected, content) => {
              const copy =
                sandboxApply && session?.id
                  ? sandboxCopyOfProjectFile(
                      fileDiffs.map((f) => f.path),
                      sandboxApply.planFor,
                      folder,
                      projectPath
                    )
                  : null
              if (!copy || !session?.id) throw new Error(`${projectPath} has no sandbox copy`)
              const outcome = await applySandboxHunk({
                session: session.id,
                path: copy.plan.source,
                project: copy.plan.folder,
                destination: copy.plan.destination,
                expected,
                content,
              })
              if (outcome === 'applied') git.refresh()
              return outcome
            }}
            onApplySandboxCopy={(projectPath) => {
              if (!sandboxApply) return
              const copy = sandboxCopyOfProjectFile(
                fileDiffs.map((f) => f.path),
                sandboxApply.planFor,
                folder,
                projectPath
              )
              if (!copy) return
              // Confirmed in the peek ("Apply whole file…"), with the change in view.
              void sandboxApply
                .apply(copy.path, true)
                .then(() => toast.success(t('common:changes.applyReplaced')))
                .catch((e) =>
                  toast.error(
                    t('common:changes.applyFailed', { message: errorText(e) })
                  )
                )
            }}
            // Hand edits save where the agent's writes would, under the same
            // grant; with no live grant a real-tree mode stays read-only.
            editAccess={{
              destination: effective.destination,
              writeGrant: relativeIsProject
                ? (liveGrant?.grantId ?? null)
                : null,
            }}
            readRoot={treeRoot}
            extraFolders={extraFolders}
            onSaved={() => git.refresh()}
          />
        )}
        {phone && !panelShown && (
          <CoworkSidePanel
            title={t('common:coworkLayout.output')}
            onClose={() => showView('content')}
          >
            <p className="p-4 text-sm text-muted-foreground">
              {t('common:rail.chooseView')}
            </p>
          </CoworkSidePanel>
        )}
          </CoworkInspectorFrame>
        )}
      </div>
      </CoworkInspectorProvider>
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
