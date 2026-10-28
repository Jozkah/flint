/* eslint-disable @typescript-eslint/no-explicit-any */
import { useSecondClock } from '@/lib/sharedClock'
import { isPlatformTauri } from '@/lib/platform/utils'
import { promptReplaceModels } from '@/hooks/useModelReplacePrompt'
import { toAssetUrl } from '@/lib/assetPath'
import { modelKey, unavailableModels } from '@/lib/modelReplace'
import { messageWeight, transcriptWindowStart } from '@/lib/transcriptWindow'
import { markConversationOpened } from '@/lib/messageEntry'
import { useRemoteComposer } from '@/lib/remote/composer'
import { AgentBrowserWindow } from '@/containers/AgentBrowserWindow'
import {
  useBrowserToolMirror,
  useBrowserToolMirrorListening,
} from '@/hooks/useBrowserToolMirror'
import { closeBrowserSession } from '@/lib/browserTool'
import { BrowserVerifyPanel } from '@/containers/BrowserVerifyPanel'
import { useBrowserVerify } from '@/hooks/useBrowserVerify'
import type { VerifyReport } from '@/lib/browserVerify'
import { currentDoctorResult, observedToolsFact, useModelDoctor } from '@/hooks/useModelDoctor'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { parseSlashMarker, slashDisplay } from '@/lib/slashCommands'
import { type WidgetHost } from '@/lib/visualize/hostContext'
import type { CodeOpenOptions, CodePathCheck } from '@/lib/codeOpen'
import { resolveCodePath } from '@/lib/codePathResolve'
import HeaderPage from '@/containers/HeaderPage'
import {
  CoworkSplitWorkspace,
  SplitToggleButton,
} from '@/containers/SplitConversation'
import { ACTIVE_PANE_RING, useCoworkPane, usePaneChrome } from '@/hooks/useCoworkPane'
import { PaneHeaderBar } from '@/containers/PaneHeaderBar'
import { useLiveJobs } from '@/lib/coworkJobsPoller'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { route } from '@/constants/routes'
import { ensureCoworkEnabled } from '@/lib/coworkGate'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
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
import { previewKindFor, resolveInRoot } from '@/lib/coworkPreview'
import { codePathExists } from '@/lib/codePathExists'
import { readTextBounded } from '@/lib/boundedRead'
import { Frame, FrameBody } from '@/components/ui/frame'
import { Chip } from '@/components/ui/chip'
import { Button } from '@/components/ui/button'
import { useCoworkLayout, type CoworkPhoneView } from '@/hooks/cowork/useCoworkLayout'
import {
  CoworkInspectorFrame,
  CoworkInspectorProvider,
  CoworkSidePanel,
  type InspectorLayout,
} from '@/containers/CoworkSidePanel'
import {
  useCoworkSessions,
  ensureCurrentSession,
  startPaneSession,
  } from '@/hooks/useCoworkSessions'
import { useSessionWorkspacePath } from '@/hooks/useSessionWorkspacePath'
import { useSplitConversation } from '@/hooks/useSplitConversation'
import { resolveCoworkModel } from '@/lib/coworkModelChoice'
import { confirmBypass } from '@/lib/bypassConfirm'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import {
  runTitle,
  type RunContext,
} from '@/lib/coworkActivityRecorder'
import {
  finishedJobPatch,
} from '@/lib/coworkTasks'
import {
  findTaskByJob,
  backgroundTasksOf,
  sessionTotals,
  sessionWorkflows,
  type ActivityTask,
  type WorkflowView,
} from '@/lib/coworkActivity'
import {
  cancelMessage,
  cancelTask as cancelTaskRequest,
  cancelWorkflow as cancelWorkflowRequest,
  patchForOutcome,
} from '@/lib/coworkCancel'
import type { AskAnswer, CoworkTurn, Usage } from '@/types/coworkSession'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import {
  useMessageQueue,
  type QueuedMessageSender,
} from '@/stores/message-queue-store'
import {
  agentAttribution,
  drainIdleSession,
} from '@/lib/mailboxDelivery'
import { PageHeaderRow } from '@/containers/PageHeaderRow'
import { useModelProvider } from '@/hooks/useModelProvider'
import { enableModelCapabilities } from '@/lib/modelCapabilityEnable'
import { selectionForThreadModel } from '@/hooks/useConversationPane'
import {
  appendLiveMessages,
  assistantAnchorId,
  coworkTurnsToUIMessages,
} from '@/lib/coworkTurns'
import { reconcileToolActivity } from '@/lib/coworkActivityTimeline'
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
import {
  formatChangeSummary,
  janAuthoredChanges,
} from '@/lib/coworkChangeSummary'
import {
  loadToolActivity,
  recordLifecycle,
  type ToolActivityItem,
} from '@/lib/toolActivity'
import { createStreamSink } from '@/lib/cowork/run/streamSink'
import { createLiveLane } from '@/lib/cowork/run/liveLane'
import { createStepHandlers } from '@/lib/cowork/run/stepHandlers'
import { createToolHandlers } from '@/lib/cowork/run/toolHandlers'
import { createTeamTool } from '@/lib/cowork/run/teamTool'
import { createApprovalHooks } from '@/lib/cowork/run/approvalHooks'
import { createMainDispatch } from '@/lib/cowork/run/mainDispatch'
import { useAppState } from '@/hooks/useAppState'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import { CoworkWorkspacePill } from '@/containers/CoworkWorkspacePill'
import { CoworkModeSelector } from '@/containers/CoworkModeSelector'
import {
  CoworkRunSettings,
  type RunSettingsException,
} from '@/containers/CoworkRunSettings'
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
import {
  isReadOnly,
  modeOf,
  type CoworkMode,
} from '@/lib/coworkMode'
import { isSpawnedSession } from '@/lib/spawnSession'
import { workProfile } from '@/lib/workProfiles'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import {
  CoworkPinnedProgress,
  CoworkProgressButton,
} from '@/containers/CoworkPinnedProgress'
import {
  useCoworkDisplay,
  useShowPromptSnapshot,
} from '@/hooks/useCoworkDisplay'
import { CoworkSessionDetails } from '@/containers/CoworkSessionDetails'
import { rendererReadinessReports } from '@/lib/coworkRendererReadiness'
import { usePrompt } from '@/hooks/usePrompt'
import { addSnapshotSink, type PromptSnapshotRef } from '@/lib/providerFetch'
import { fromCoworkUsage, summarizeUsage } from '@/lib/tokenUsage'
import { createDecodeClock, speedStats } from '@/lib/tokenSpeed'
import {
  prepareCoworkAttachments,
  type CoworkAttachmentInput,
  type SubmittedFile,
} from '@/lib/coworkAttachments'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import {
  NO_SESSION,
  useCoworkView,
  type CoworkRail,
} from '@/hooks/useCoworkView'
import {
  isChange,
  type FileActivityEvent,
  type FileOrigin,
} from '@/lib/fileActivity'
import { loadGitStatus } from '@/lib/coworkGit'
import { awaitsModel } from '@/lib/agentActivity'
import { CoworkPreviewPanel } from '@/containers/CoworkPreviewPanel'
import { configuredContextTokens } from '@/lib/coworkContextWindow'
import { useCoworkReadiness } from '@/hooks/useCoworkReadiness'
import { CoworkTranscript } from '@/containers/CoworkTranscript'
import { CoworkCodeRail } from '@/containers/CoworkCodeRail'
import { CoworkComposerArea } from '@/containers/CoworkComposerArea'
import { CoworkDetailsBody } from '@/containers/CoworkDetailsBody'
import { CoworkDiffRail } from '@/containers/CoworkDiffRail'
import {
  applySandboxFile,
  isFlintInternalPath,
  planSandboxApply,
  } from '@/lib/coworkSandboxApply'
import { probeSandboxFile } from '@/lib/coworkApplyAll'
import { absoluteChangePath, shortToolPath } from '@/lib/codePathResolve'
import type { SandboxApplyActions } from '@/containers/CoworkApplyAllDialog'
import {
  NO_USER_EDITS,
  useCoworkUserEdits,
} from '@/hooks/useCoworkUserEdits'
import { withUserEditNotice } from '@/lib/coworkCodeEdit'
import { CoworkTasksPanel } from '@/containers/CoworkTasksPanel'
import { CoworkBackgroundTasksPanel } from '@/containers/CoworkBackgroundTasksPanel'
import { ReviewChangesContext } from '@/containers/TaskCheckoutLink'
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
import {
  extraFoldersOf,
  isInsideAnyFolder,
  mainFolderReadOnlyOf,
  sameFolder,
  withMainFolderMark,
  writableExtraFoldersOf,
} from '@/lib/coworkFolders'
import {
  CoworkRailToolbar,
  type RailMode,
} from '@/containers/CoworkRailToolbar'
import { useCoworkGitStatus } from '@/hooks/useCoworkGitStatus'
import { collectCodeFileDiffs } from '@/lib/coworkDiffs'
import {
  compactHistory,
  compactionWindow,
  resolveAutoCompact,
  DEFAULT_KEEP_RECENT,
  } from '@/lib/compaction'
import { manualSummarizer, modelSummarizer } from '@/lib/compactionSummarizer'
import { CompactionSummaryError, estimateHistoryTokens } from '@/lib/compaction'
import { fixedPromptTokens } from '@/lib/contextBreakdown'
import { useContextBreakdown } from '@/hooks/useContextBreakdown'
import {
  getCompactionPolicy,
  DEFAULT_COMPACTION_POLICY,
  type CompactionPolicy,
} from '@/lib/compactionPolicy'
import { janAuthoredPaths } from '@/lib/coworkOrigins'
import {
  deriveRunOutcome,
  } from '@/lib/coworkRunOutcome'
import { isCoordinatorEligible } from '@/lib/campaignTools'
import { useRegisterHostedSession } from '@/lib/coworkHosting'
import { useCampaignLaunchSend } from '@/hooks/useCampaignLaunchSend'
import { groupsToOffer } from '@/lib/coworkToolGroups'
import { projectInitLabel, useProjectInitDrafts } from '@/lib/projectInit'
import {
  createMailLedger,
} from '@/lib/mailAutoReply'
import { holdQueueThenStop } from '@/lib/chatSteering'
import { useShallow } from 'zustand/react/shallow'
import {
  recoveryHidden,
  } from '@/lib/coworkWorktrees'
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
  accessShortLabelKey,
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
  parseSkillRequestTriggers,
  resolveSkills,
  unresolvedSkills,
  type ContextAccounting,
  type InstructionFile,
  type InstructionProbe,
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
import {
  useCoworkWorktrees,
  type WorktreeRecord,
} from '@/hooks/useCoworkWorktrees'
import { DEFAULT_SESSION_TITLE, isSessionEmpty } from '@/lib/coworkSessionStart'
import { useAutoSessionWorktree } from '@/hooks/useAutoSessionWorktree'
import { useCoworkParallel } from '@/hooks/useCoworkParallel'
import { useSavedWorkflowBuiltins } from '@/hooks/useSavedWorkflowBuiltins'
import { recordEvents } from '@/lib/eventLog'
import {
  getSandboxStatus,
  getSandboxToolchains,
  sandboxEnforces,
} from '@/lib/agentTools'
import {
  coworkWebSearchScope,
  useWebSearchOn,
  webSearchOnFor,
} from '@/hooks/useWebSearchChoice'
import { MAX_AGENT_STEPS } from '@/lib/coworkBudget'
import {
  abortRun,
  abortAll,
  beginRun,
  endRun,
  hasSubagent,
  isAbortLike,
  answerAsk,
  runTurn,
  untilStopped,
  type RunOutcome,
} from '@/lib/coworkRunner'
import { useCoworkRun, type RunEnding } from '@/hooks/useCoworkRun'
import {
  allowedRemoteModes,
  isRemoteSession,
  modeToAccess,
  serverPageMode,
  setRemoteMode,
  startRemoteSession,
  useRemoteCowork,
  useRunnerInfo,
} from '@/lib/remoteCowork'
import { setRunModel } from '@/lib/remoteRunner'
import { isServerTransport } from '@/lib/serverTransportFlag'
import { pickServerFolder } from '@/lib/serverFolderPicker'
import {
  listSubagents,
  type SubagentDefinition,
} from '@/lib/coworkSubagentRegistry'
import {
  SUBAGENT_RESULT_HEAD_CHARS,
} from '@/lib/coworkSubagent'
import { BackgroundTasks } from '@/lib/coworkBackgroundTasks'
import { createChildRunner } from '@/lib/coworkChildRunner'
import { DelegationNudge } from '@/lib/delegationNudge'
import { errorText } from '@/lib/errorText'
import { loadProjectTooling, type LoadedTooling } from '@/lib/projectTooling'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { useMCPServers } from '@/hooks/useMCPServers'
import { sessionDetailsLabel } from '@/lib/windowTitle'
import { autoTitleCoworkSession } from '@/lib/coworkAutoTitle'
import { runStatus } from '@/lib/runStatus'
import { chooseWorkProfile, useWorkProfiles } from '@/hooks/useWorkProfiles'
import { CoworkWorkProfilePicker } from '@/containers/CoworkWorkProfilePicker'
import {
  EMPTY_SUMMARY,
  attentionCount,
  type NarrowBarsSummary,
} from '@/containers/NarrowStatusStrip'
import { CoworkRunChip } from '@/containers/CoworkRunChip'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useJevSettings } from '@/hooks/useJevSettings'
import { workProfileAsker } from '@/lib/jev'
import { useMemoryProposals } from '@/hooks/useMemoryProposals'
import { SMALL_WINDOW_TOKENS } from '@/lib/coworkTools'


export const Route = createFileRoute(route.cowork)({
  beforeLoad: () => ensureCoworkEnabled(),
  component: CoworkRoute,
})

/** The current session, with any split-view panes beside it. */
/** The session's mode as it is now, for a run that froze its own at the start. */
function liveSessionMode(sid: string): CoworkMode | undefined {
  const session = useCoworkSessions.getState().sessions.find((x) => x.id === sid)
  return session ? modeOf(session) : undefined
}

function CoworkRoute() {
  return (
    <CoworkSplitWorkspace>
      <CoworkPage />
    </CoworkSplitWorkspace>
  )
}

/** Same shape the other Cowork surfaces use; kept local, as they do. */
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
  // The campaign run host leaves a session this page shows to this page.
  useRegisterHostedSession(coworkPane?.sessionId)
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
  // The ones a write grant may cover: the rest the user marked read-only.
  const sessionReadOnlyExtras = session?.readOnlyExtraFolders
  const writableExtraFolders = useMemo(
    () =>
      writableExtraFoldersOf({
        folder,
        extraFolders: sessionExtraFolders,
        readOnlyExtraFolders: sessionReadOnlyExtras,
      }),
    [folder, sessionExtraFolders, sessionReadOnlyExtras]
  )
  // The main folder's own mark, independent of the extras'. Under Edit this
  // folder it decides whether the grant covers the main folder at all.
  const mainFolderReadOnly = session
    ? mainFolderReadOnlyOf(session)
    : false
  // Apply to folder copies into the primary or any extra folder; a sandbox
  // path that starts with an extra folder's name goes to that folder.
  const applyFolders = useMemo(
    () => (folder ? [folder, ...extraFolders] : []),
    [folder, extraFolders]
  )
  // On a server page the mode is the server's: a server session shows the
  // access the server reported, and nothing defaults to Auto there.
  const mode = isServerTransport() ? serverPageMode(session ?? undefined) : modeOf(session ?? {})
  const runnerInfoForModes = useRunnerInfo(isServerTransport())
  const modeOptions = isServerTransport() ? allowedRemoteModes(runnerInfoForModes) : undefined

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
  /** Sessions whose run ended to take a folder and should restart with it. */
  const restartAfterFolderRef = useRef<Record<string, true>>({})
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
  // The run's transport, so a Settings toggle can be pushed to it in place
  // (web tools added or removed) rather than letting the next step rebuild
  // the advertised set and discard the prompt prefix.
  const transportRef = useRef<CoworkChatTransport | null>(null)

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
  // Server sessions: the list, the opened transcript, a turn still running.
  useRemoteCowork()
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
    extraFolders: writableExtraFolders,
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

  const settingsMcpServers = useMCPServers(
    (s) => Object.values(s.mcpServers).filter((c) => c?.active).length
  )
  // The servers a run would be offered right now: switched on and listing tools.
  const mcpToolList = useAppState((s) => s.tools)
  const mcpServerConfigs = useMCPServers((s) => s.mcpServers)
  const connectedMcpServers = useMemo(
    () =>
      [
        ...new Set(
          mcpToolList
            .map((tool) => tool.server)
            .filter((server) => mcpServerConfigs[server]?.active)
        ),
      ].sort(),
    [mcpToolList, mcpServerConfigs]
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
  // Settings decide the default; the session's own switch, once flipped, wins.
  const webSearchEnabled = useWebSearchOn(
    session?.id ? coworkWebSearchScope(session.id) : null
  )
  const hasTurns = (session?.turns?.length ?? 0) > 0
  // A Settings toggle applies at the next run, like a mode change: the run's
  // advertised set is frozen for its lifetime, so the toggle is pushed to the
  // transport in place (web tools added or removed) rather than letting the
  // next step rebuild the set and discard the prompt prefix.
  useEffect(() => {
    transportRef.current?.setWebSearch(webSearchEnabled)
  }, [webSearchEnabled])
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
  const { readiness } = useCoworkReadiness({
    sessionId: session?.id,
    messages: session?.messages,
    runContext,
    mode,
    subagentDefs,
    workspacePath,
    folder,
    extraFolders,
    destination: effective.destination,
    worktree,
    gitBranch,
    projectInstructions,
    compat,
    tooling,
    webSearchEnabled,
    hasTurns,
    modelCapabilities,
    instructionFiles,
    baseline: runOrigins?.context.baseline,
    advertisedToolCount,
    connectedMcpServers,
    availableSkills,
    enabledSkills,
    composerPrompt,
    selectedModel,
  })

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
  const [lastPreviewRoot, setLastPreviewRoot] = useState<string | undefined>(undefined)
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
      if (!shouldOpenInCode(path) && previewKindFor(path) !== 'file') {
        const absolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path)
        const root = absolute
          ? [treeRoot, workspacePath, ...extraFolders].find(
              (candidate) => candidate && resolveInRoot(candidate, path)
            )
          : relativeIsProject ? treeRoot : workspacePath
        if (root) {
          setLastPreviewPath(path)
          setLastPreviewRoot(root)
          setRail({ kind: 'preview', path, root })
        }
        return
      }
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
    [resolveToolPath, treeRoot, workspacePath, extraFolders, relativeIsProject, openCode, session?.id, setRail]
  )
  /** Why a path cannot be opened, for its tooltip. */
  const checkToolPath = useCallback(
    (path: string): CodePathCheck => {
      if (previewKindFor(path) !== 'file') {
        const absolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path)
        const root = absolute
          ? [treeRoot, workspacePath, ...extraFolders].find(
              (candidate) => candidate && resolveInRoot(candidate, path)
            )
          : relativeIsProject ? treeRoot : workspacePath
        return root ? { ok: true } : { ok: false, reason: t('common:preview.outside') }
      }
      const resolved = resolveToolPath(path)
      return resolved.kind === 'unresolved'
        ? {
            ok: false,
            reason: t(`common:codePanel.unresolved.${resolved.reason}`),
          }
        : { ok: true }
    },
    [resolveToolPath, treeRoot, workspacePath, extraFolders, relativeIsProject, t]
  )
  /** Does a clicked path's file exist? Only a definite "not found" is false. */
  const toolPathExists = useCallback(
    (path: string) =>
      codePathExists(resolveToolPath(path), {
        project: async (rel) => {
          if (!treeRoot) return
          const dataFolder = await serviceHub.app().getJanDataFolder()
          if (!dataFolder) return
          await projectReadFile(dataFolder, treeRoot, rel, false)
        },
        sandboxMissing: async (rel) => {
          const abs = workspacePath ? resolveInRoot(workspacePath, rel) : null
          if (!abs) return false
          const read = await readTextBounded(await toAssetUrl(abs), {
            maxBytes: 4096,
          })
          return read.status === 'missing'
        },
      }),
    [resolveToolPath, treeRoot, workspacePath, serviceHub]
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
  /**
   * A path in the run summary: the Code panel or preview where one can show
   * it, otherwise the system's default app, so no listed file is a dead label.
   */
  const openSummaryPath = useCallback(
    (path: string) => {
      if (shouldOpenInCode(path) || previewKindFor(path) !== 'file') {
        openToolPath(path)
        return
      }
      const absolute = absoluteChangePath(path, 'session', {
        treeRoot,
        workspacePath,
        resolved: resolveToolPath(path),
      })
      if (!absolute) return
      void serviceHub
        .opener()
        .openPath(absolute, pathLinkRoots)
        .catch((e) => toast.error(errorText(e)))
    },
    [openToolPath, treeRoot, workspacePath, resolveToolPath, serviceHub, pathLinkRoots]
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
        setLastPreviewRoot(workspacePath ?? undefined)
        setRail({ kind: 'preview', path, root: workspacePath ?? undefined })
      }
    },
    [openCode, session?.id, setRail, workspacePath]
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
      setRail(kind === 'preview' ? { kind, path: lastPreviewPath, root: lastPreviewRoot } : { kind })
    },
    [lastPreviewPath, lastPreviewRoot, rail?.kind, setRail]
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

  const attachFolder = useCallback(async (given?: string) => {
    const openingSessionId = session?.id
    // A browser cannot open a native folder dialog: on a page `flint serve`
    // serves, the folders come from the server's allowed roots instead.
    const picked =
      typeof given === 'string'
        ? given
        : isServerTransport()
          ? await pickServerFolder()
          : await serviceHub.dialog().open({ directory: true })
    if (typeof picked !== 'string') return
    // Nothing else checks a path handed in (typed, pasted, or from a stale
    // list): attaching one that is not there built suggestions out of nothing.
    if (isPlatformTauri() && !isServerTransport()) {
      let isFolder = true
      try {
        const { fs } = await import('@janhq/core')
        if (typeof fs?.fileStat === 'function') {
          const stat = await fs.fileStat(picked)
          isFolder = Boolean(stat?.isDirectory)
        }
      } catch {
        isFolder = false
      }
      if (!isFolder) {
        toast.error(t('common:workspace.folderNotFound', { path: picked }))
        return
      }
    }
    // A split-view pane's session is never the global current one, so it is
    // compared against the pane's own id.
    if (openingSessionId &&
      (paneSessionIdRef.current ?? useCoworkSessions.getState().currentId) !==
        openingSessionId) return
    const sid = ensureCurrentSession(paneSessionIdRef.current)
    // A page `flint serve` serves has no agent tools of its own: a blank
    // local session given a server folder becomes a server session there.
    if (isServerTransport() && typeof given !== 'string' && !isRemoteSession(sid)) {
      const current = useCoworkSessions.getState().sessions.find((x) => x.id === sid)
      if (!current || isSessionEmpty(current)) {
        try {
          // The mode picked before the folder travels with the new session.
          await startRemoteSession({
            folder: picked,
            ...(current?.mode ? { access: modeToAccess(current.mode) } : {}),
          })
          return
        } catch (e) {
          // A server that does not run sessions: attach as before.
          console.warn('server session not started', e)
        }
      }
    }
    if (!useCoworkRun.getState().runs[sid] && authorityMayChange(sid))
      useCoworkSessions.getState().setFolder(sid, picked)
    else setPendingFolder((pending) => ({ ...pending, [sid]: picked }))
    setPendingAccess((pending) => {
      if (!pending[sid]) return pending
      const next = { ...pending }
      delete next[sid]
      return next
    })
  }, [serviceHub, session?.id, t])

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
    const picked = isServerTransport()
      ? await pickServerFolder()
      : await serviceHub.dialog().open({ directory: true })
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

  /**
   * Mark one folder, the main one (`null`) or an extra, editable or
   * read-only. Every folder has its own mark, in any combination.
   *
   * The grant covers exactly the editable folders, so it is re-issued for the
   * new set (the backend replaces the session's grant); a grant that leaves
   * the main folder out refuses writes there. Making a folder editable from
   * Review only makes that one folder editable and moves the session to Edit
   * this folder; marking the last editable folder read-only returns it to
   * Review only. If re-issuing fails, the old grant may cover a folder now
   * marked read-only, so it is withdrawn and the session returns to Review
   * only. In a managed worktree the main folder is edited through the
   * worktree and only the extras toggle.
   */
  const setFolderWritable = useCallback(
    async (target: string | null, writable: boolean) => {
      if (!session?.id || !session.folder || folderHeld(session.id)) return
      const sid = session.id
      const store = useCoworkSessions.getState()
      const before = store.sessions.find((x) => x.id === sid)
      if (!before?.folder) return
      const worktreeMode = accessOf(before) === 'managed-worktree'
      if (target === null && worktreeMode) return
      const grant = useDirectEditGrants.getState().grantFor(sid)
      // No grant: nothing is editable (Review only), or a worktree run whose
      // grant has not arrived; only the former is left by a toggle.
      if (!grant && (worktreeMode || !writable)) return
      if (!grant) {
        store.setMainFolderReadOnly(sid, target !== null)
        for (const extra of extraFoldersOf(before)) {
          store.setExtraFolderWritable(
            sid,
            extra,
            target !== null && sameFolder(extra, target)
          )
        }
      } else if (target === null) {
        store.setMainFolderReadOnly(sid, !writable)
      } else {
        store.setExtraFolderWritable(sid, target, writable)
      }
      const updated = useCoworkSessions
        .getState()
        .sessions.find((x) => x.id === sid)
      if (!updated) return
      const mainWritable = worktreeMode || !mainFolderReadOnlyOf(updated)
      const extras = writableExtraFoldersOf(updated)
      const fallBack = async () => {
        await useDirectEditGrants.getState().revokeSession(sid)
        useCoworkSessions.getState().setAccess(sid, 'review-only')
      }
      if (!mainWritable && extras.length === 0) {
        // No folder is editable any more: the session is Review only.
        await fallBack()
        return
      }
      const dataFolder = await serviceHub.app().getJanDataFolder()
      const result = dataFolder
        ? await useDirectEditGrants
            .getState()
            .authorize(
              sid,
              grant?.folder ?? before.folder,
              dataFolder,
              extras,
              mainWritable
            )
        : { ok: false as const, reason: 'no data folder' }
      if (!result.ok) {
        await fallBack()
        if (result.reason !== 'superseded') toast.error(result.reason)
        return
      }
      if (!grant) useCoworkSessions.getState().setAccess(sid, 'edit-folder')
    },
    [session?.id, session?.folder, folderHeld, serviceHub]
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
          source: turn.tokenSpeed?.source,
          tokenCount: turn.tokenSpeed?.tokenCount ?? turn.usage?.completion_tokens,
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
    // Applying writes this machine's files through desktop-only commands; the
    // browser client of `flint serve` reviews without them.
    if (!isPlatformTauri() || !folder || !applySessionId) return undefined
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
            .authorize(sessionId, target, data, writableExtraFolders),
        revokeSession: (sessionId) =>
          useDirectEditGrants.getState().revokeSession(sessionId),
        // Read after the await, so it sees where the user actually is.
        currentBinding: () => bindingRef.current,
        setAccess: (sessionId) => {
          // Choosing Edit this folder edits the main folder: its read-only
          // mark goes back to being derived from the access.
          useCoworkSessions.getState().setMainFolderReadOnly(sessionId, undefined)
          useCoworkSessions.getState().setAccess(sessionId, 'edit-folder')
        },
      })
      if (result === 'granted') setConfirmDirectEdit(false)
      return result === 'granted'
    } finally {
      done()
    }
  }, [
    session?.id,
    folder,
    writableExtraFolders,
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
          .authorize(
            sid,
            folder,
            dataFolder,
            writableExtraFolders,
            !mainFolderReadOnly
          )
        if (!result.ok) {
          // One toast per folder: reopening sessions that share an unreadable
          // folder updated the same message instead of stacking copies, and it
          // clears itself.
          if (result.reason !== 'superseded')
            toast.error(result.reason, {
              id: `folder-access:${folder}`,
              duration: 8000,
            })
          return
        }
        const current = useCoworkSessions
          .getState()
          .sessions.find((entry) => entry.id === sid)
        if (current?.folder !== folder || accessOf(current) !== 'edit-folder') {
          await useDirectEditGrants.getState().revokeSession(sid)
        }
      } catch (error) {
        toast.error(String(error), {
          id: `folder-access:${folder}`,
          duration: 8000,
        })
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
    writableExtraFolders,
    mainFolderReadOnly,
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
        .authorize(sid, created.record.path, dataFolder, writableExtraFolders)
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
    writableExtraFolders,
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
      // The run ended to take this folder: carry on in a new one with it.
      if (restartAfterFolderRef.current[sid]) {
        delete restartAfterFolderRef.current[sid]
        void runRequestRef.current(null)
      }
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
  // The Background tasks tab reads the same record; it exists only while it
  // has rows.
  const backgroundTasks = useMemo(
    () =>
      session?.id
        ? backgroundTasksOf(activity, session.id)
        : { running: [], finished: [] },
    [activity, session?.id]
  )
  // Clearing the last row removes the tab, so its panel does not stay open on
  // nothing.
  const backgroundCount =
    backgroundTasks.running.length + backgroundTasks.finished.length
  useEffect(() => {
    if (rail?.kind === 'background' && backgroundCount === 0) setRail(null)
  }, [rail?.kind, backgroundCount, setRail])

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
  const activityActive = taskCounts.running + taskCounts.queued > 0
  const activityNow = useSecondClock(activityActive)

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
  // A child in a checkout of its own: its row leads to the Changes panel, where
  // the review list shows that child's work.
  const [reviewFocusTaskId, setReviewFocusTaskId] = useState<string | null>(null)
  const reviewChildChanges = useCallback(
    (task: ActivityTask) => {
      setReviewFocusTaskId(task.checkout?.taskId ?? null)
      setRail({ kind: 'diff' })
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
    () => runStatus(running, displayedTurns, t),
    [running, displayedTurns, t]
  )
  // A run held on an approval is waiting for the user, not working: the
  // status line and the activity card stop their clocks and say so.
  const waitingForUser = useToolApprovalRequests((s) =>
    Object.values(s.pending).some((p) => p.threadId === session?.id)
  )
  // The approvals waiting in this session, as one key so the selector is
  // stable: the strip counts them and goes to the first.
  const waitingRequestIds = useToolApprovalRequests((s) =>
    Object.values(s.pending)
      .filter((p) => p.threadId === session?.id)
      .map((p) => p.requestId)
      .join('\n')
  )
  const [barsSheetOpen, setBarsSheetOpen] = useState(false)
  const [barsSummary, setBarsSummary] = useState<NarrowBarsSummary>(EMPTY_SUMMARY)
  const waitingIds = waitingRequestIds ? waitingRequestIds.split('\n') : []
  // At every width: one thing over the composer shows as its bar; two or
  // more (waiting for you counts) fold into one strip of chips, the bars
  // themselves one tap away in a sheet.
  const stripMode = attentionCount(waitingIds.length, barsSummary) >= 2


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
    attachmentInput?: CoworkAttachmentInput,
    // Called when the request is refused before a run starts (no usable model,
    // a model that cannot call tools, a stale worktree), so the composer can
    // give the draft back instead of losing it.
    onRefused?: () => void
  ) => {
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
    if (!selectedModel?.id) {
      toast.error(
        resolved.unavailable
          ? t('common:sessionModelUnavailable', { model: resolved.unavailable.id })
          : resolved.needsKey
            ? t('common:selectModelNoKey', { provider: resolved.needsKey })
            : t('common:selectModel')
      )
      onRefused?.()
      return
    }
    // Without tool calling the transport drops the tool set silently, and the
    // agent then narrates work it never did. Refusing up front is honest; a
    // toolless "agent" run is worse than no run.
    if (!selectedModel.capabilities?.includes('tools')) {
      // A custom endpoint never reports capabilities, so the model can be fine
      // and still look toolless. Offer the user's own override where the
      // refusal is, the way a tool-call message offers it in chat.
      const modelId = selectedModel.id
      const providerId = resolved.choice?.provider ?? globalProvider
      // Kept until dismissed: it is the only sign the send was refused, and
      // its action is the fix (CW-002: a 4 s toast read as a silent no-op).
      toast.error(t('common:modelNoTools', { model: modelId }), {
        duration: Infinity,
        action: providerId
          ? {
              label: t('common:modelCapability.enableAlways'),
              onClick: () => {
                const store = useModelProvider.getState()
                const owner = store.getProviderByName(providerId)
                if (!owner) return
                store.updateProvider(providerId, {
                  ...owner,
                  models: enableModelCapabilities(owner.models, modelId, [
                    'tools',
                  ]),
                })
              },
            }
          : undefined,
      })
      onRefused?.()
      return
    }
    // A restored session may remember Managed worktree while its process-local
    // grant is still being reissued. Do not start a Review run against the
    // source folder: history would point at a worktree the run cannot read.
    if (access === 'managed-worktree' && effective.destination !== 'managed') {
      const key = effectiveDowngradeKey(effective)
      if (key) toast.error(t(key))
      onRefused?.()
      return
    }
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

  // Read through a ref so the memoized message rows keep a stable callback
  // while still calling the current render's closure.
  const runRequestRef = useRef(runRequest)
  runRequestRef.current = runRequest

  const handleSubmit = (
    text: string,
    files?: SubmittedFile[],
    onRefused?: () => void
  ) => {
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
    void runRequest(
      body,
      undefined,
      false,
      hasFiles ? { docs, files } : undefined,
      onRefused
    )
  }
  // A paired phone's message to the session in view takes the same path.
  useRemoteComposer('cowork', session?.id, handleSubmit)
  // A widget's button sends its prompt as the user's next message, once the
  // run in view has ended.
  const widgetBusyRef = useRef(false)
  widgetBusyRef.current = running
  const widgetSubmitRef = useRef(handleSubmit)
  widgetSubmitRef.current = handleSubmit
  const widgetHost = useMemo<WidgetHost>(
    () => ({
      sendPrompt: (text) => {
        if (widgetBusyRef.current) return false
        widgetSubmitRef.current(text)
        return true
      },
    }),
    []
  )
  // The opening message of a campaign started from "New campaign" is sent
  // through the same path as the Send button once the session is idle.
  useCampaignLaunchSend({
    sessionId: session?.id,
    running,
    draftScope: coworkPane?.draftScope,
    submit: (text, onRefused) =>
      widgetSubmitRef.current(text, undefined, onRefused),
  })
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
    [t, running, savedWorkflowBuiltins]
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
    !running && session?.id
      ? s.getQueue(session.id).filter((m) => !m.held).length
      : 0
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
    setLastPreviewRoot(workspacePath ?? undefined)
    setRail({ kind: 'preview', path: pendingPreview.path, root: workspacePath ?? undefined })
    useCoworkRun.getState().clearPendingPreview()
  }, [pendingPreview, session?.id, setRail, workspacePath])

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

  const {
    paneChrome,
    compactViews,
    narrow,
    phone,
    compactRun,
    phoneStrip,
    view,
    showView,
    revealOutput,
    openRail,
    closeRail,
  } = useCoworkLayout({ scrollNode, setRail })
  // The agent's browser (the `browser` tool) gets its own tab in the output
  // panel: it opens when the agent opens a page and goes when its browser closes.
  useBrowserToolMirrorListening()
  const agentBrowserOpen = useBrowserToolMirror((s) =>
    session?.id ? Boolean(s.byId[session.id]) : false
  )
  const sawAgentBrowser = useRef(false)
  useEffect(() => {
    if (agentBrowserOpen && !sawAgentBrowser.current) {
      sawAgentBrowser.current = true
      setRail({ kind: 'browser' })
    } else if (!agentBrowserOpen && sawAgentBrowser.current) {
      sawAgentBrowser.current = false
      if (rail?.kind === 'browser') setRail(null)
    }
    // Only the browser appearing or going away moves the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentBrowserOpen])
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
      rail.kind === 'background' ||
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
      <span className="max-lg:sr-only">{t('common:coworkLayout.output')}</span>
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
      agentBrowser={agentBrowserOpen}
      changeCount={changeCounts.fileCount}
      additions={changeCounts.additions}
      deletions={changeCounts.deletions}
      changeSummary={formatChangeSummary(changeCounts)}
      activity={taskCounts}
      background={{
        running: backgroundTasks.running.length,
        total: backgroundTasks.running.length + backgroundTasks.finished.length,
      }}
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
      onModelChange={(model) => {
        const sid = ensureCurrentSession(paneSessionIdRef.current)
        useCoworkSessions.getState().setModel(sid, {
          provider: model.provider,
          id: model.id,
        })
        if (!isServerTransport()) return
        // On a server page the choice is also the browser's stored selection,
        // the model server sessions default to, and a server session in view
        // switches to it on the server.
        useModelProvider.getState().selectModelProvider(model.provider, model.id)
        if (isRemoteSession(sid)) {
          void setRunModel(sid, model.id)
            .then(() =>
              useCoworkSessions.setState((st) => ({
                sessions: st.sessions.map((x) =>
                  x.id === sid ? { ...x, remoteModel: model.id } : x
                ),
              }))
            )
            .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
        }
      }}
    />
  )

  // A server session runs with the server's model, which may differ from the
  // picker's: the header names the one it runs with.
  const serverModelChip = session?.remote ? (
    <span
      data-testid="cowork-server-model"
      className={cn(
        'min-w-0 shrink truncate rounded-full border px-2 py-0.5 text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground',
        // On a phone it shares the row with the view switch, which keeps its room.
        phone ? 'max-w-24' : 'max-w-56'
      )}
      title={session.remoteModel ?? undefined}
    >
      {t('integrations:serverSession.runsWith', {
        model: session.remoteModel || t('integrations:remoteRunner.serverDefault'),
      })}
    </span>
  ) : null

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
  // on phones, and quiet in the row under a pane's composer.
  const workspacePillOf = (variant: 'pill' | 'quiet') => (
    <>
      <CoworkWorkspacePill
        variant={variant}
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
        // With no folder, describe what attaching will give: direct editing,
        // unless automatic worktrees are on (useCoworkSessions' attach default).
        access={
          folder
            ? effective.access
            : useCoworkParallel.getState().autoWorktree
              ? 'review-only'
              : 'edit-folder'
        }
        extraFolders={extraFolders}
        extraFoldersWritable={
          capabilityState.known && capabilityState.directEdit
        }
        readOnlyExtraFolders={session?.readOnlyExtraFolders}
        onToggleExtraWritable={(extra, writable) =>
          void setFolderWritable(extra, writable)
        }
        mainFolderReadOnly={mainFolderReadOnly}
        onToggleMainWritable={(writable) =>
          void setFolderWritable(null, writable)
        }
        onAddExtra={() => void addExtraFolder()}
        onRemoveExtra={(extra) => void removeExtraFolder(extra)}
      />
    </>
  )
  const workspacePill = workspacePillOf('pill')

  // What the run may do and how it works: under the composer, as quiet
  // one-word buttons (Claude's layout), in a split pane as well.
  const runControls = (variant: 'pill' | 'quiet') => {
    const modeSelector = (
      <CoworkModeSelector
        variant={variant}
        mode={mode}
        options={modeOptions}
        // A choice made before the first message still needs a session to
        // live on; dropping it left the session in its default mode while the
        // user believed they had picked another.
        onChange={async (next) => {
          // Bypass runs everything without asking, host commands included:
          // say so before the first switch of the app run.
          if (
            next === 'bypass' &&
            !(await confirmBypass(t('permissions:settings.bypassConfirm')))
          ) {
            return
          }
          const sid = ensureCurrentSession(paneSessionIdRef.current)
          useCoworkSessions.getState().setMode(sid, next)
          // The calls already waiting on a card are the ones this switch is for.
          if (next === 'bypass') {
            useToolApprovalRequests.getState().allowPendingForThread(sid)
          }
          // A server session runs with the server's access: the choice is
          // sent there, and the picker shows what the server answered. One
          // that does not land is sent again before the next message.
          if (isRemoteSession(sid)) {
            void setRemoteMode(sid, next).catch((e) =>
              toast.error(e instanceof Error ? e.message : String(e))
            )
          }
        }}
      />
    )
    const profilePicker =
      workProfilesOn && session?.id ? (
        <CoworkWorkProfilePicker
          variant="pill"
          choice={workProfileChoice}
          onChoose={(id) => useWorkProfiles.getState().choose(session.id, id, true)}
          onAuto={() => useWorkProfiles.getState().clearManual(session.id)}
        />
      ) : null
    // The mode and the effort sit in the row itself, one click away; only
    // the work profile stays behind the group, named beside it when set.
    const exceptions: RunSettingsException[] = []
    if (workProfileChoice?.manual)
      exceptions.push({ id: 'profile', label: workProfile(workProfileChoice.id).label })
    return (
    <>
      {/* Folder access stays in the row: it says what can be written. */}
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
      {modeSelector}
      {profilePicker && (
        <CoworkRunSettings exceptions={exceptions}>{profilePicker}</CoworkRunSettings>
      )}
    </>
    )
  }

  // A pane or a phone has no header row for its folder, so the folder joins
  // the quiet row under the composer, before what the run may do; the row
  // inside the box keeps only attach, options and skills.
  const belowComposerControls = compactRun ? (
    // Up to 900px: one Run chip, its folder, access and mode behind it, so
    // the row under the composer holds the chip, the effort and the model.
    <CoworkRunChip
      accessLabel={t(accessShortLabelKey(effective.access))}
      access={effective.access}
    >
      {workspacePillOf('quiet')}
      {runControls('quiet')}
    </CoworkRunChip>
  ) : paneChrome || phone ? (
    <>
      {workspacePillOf('quiet')}
      {runControls('quiet')}
    </>
  ) : (
    runControls('quiet')
  )

  // Everything about the session that is reference material rather than
  // conversation: behind a dialog on wide screens, a view of its own on phones.
  const detailsBody = (
    <CoworkDetailsBody
  readiness={readiness}
  settingsMcpServers={settingsMcpServers}
  selectedProvider={selectedProvider}
  getProviderByName={getProviderByName}
  selectedModel={selectedModel}
  session={session}
  serviceHub={serviceHub}
  folder={folder}
  rendererReports={rendererReports}
  runContext={runContext}
  compat={compat}
  mcpProbes={mcpProbes}
  setMcpConsent={setMcpConsent}
  skillRoots={skillRoots}
  janDataFolder={janDataFolder}
  rescanCompat={rescanCompat}
/>
  )

  const runningChip = running ? (
    <Chip className="shrink-0 border-transparent bg-transparent text-secondary-foreground">
      <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
      {/* Icon only on a phone, in a pane, or when the header's context bar is
          too narrow for the word: the state stays visible and the folder
          chip beside it is the one that gives way. */}
      <span
        className={
          paneChrome ? 'sr-only' : 'max-md:sr-only @max-[7.5rem]/ctx:sr-only'
        }
      >
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
              paneChrome ? 'px-2 text-xs' : 'flex-1 px-2 text-[length:calc(var(--ui-font-base)*0.78125)]',
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
          {serverModelChip}
          {progressButton}
          {headerStop}
          {!phone && !showComposerRailButtons && outputToggle}
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
              {serverModelChip}
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
          {serverModelChip}
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
          <CoworkTranscript
  transcriptRef={transcriptRef}
  displayedTurns={displayedTurns}
  folder={folder}
  effective={effective}
  attachFolder={attachFolder}
  widgetHost={widgetHost}
  openToolPath={openToolPath}
  checkToolPath={checkToolPath}
  toolPathExists={toolPathExists}
  openToolDiff={openToolDiff}
  displayToolPath={displayToolPath}
  pathLinkRoots={pathLinkRoots}
  windowStart={windowStart}
  setEarlierShown={setEarlierShown}
  session={session}
  earlierPages={earlierPages}
  messageWeights={messageWeights}
  uiMessages={uiMessages}
  activity={activity}
  running={running}
  handleRegenerate={handleRegenerate}
  reasoningContainerRef={reasoningContainerRef}
  isReasoningAtBottom={isReasoningAtBottom}
  handleReasoningScroll={handleReasoningScroll}
  forceScrollReasoningToBottom={forceScrollReasoningToBottom}
  snapshotByAnchor={snapshotByAnchor}
  activityNow={activityNow}
  waitingForUser={waitingForUser}
  handleSubmit={handleSubmit}
  showTaskInPanel={showTaskInPanel}
  revealOutput={revealOutput}
  showWorkflowInPanel={showWorkflowInPanel}
  setRevealHiddenTools={setRevealHiddenTools}
  respondAsk={respondAsk}
  snapshotByMessageId={snapshotByMessageId}
  showPromptSnapshot={showPromptSnapshot}
  workspacePath={workspacePath}
  showPreview={showPreview}
  runEnding={runEnding}
  runOrigins={runOrigins}
  runOutcome={runOutcome}
  browserReports={browserReports}
  treeRoot={treeRoot}
  openSummaryPath={openSummaryPath}
  openRail={openRail}
  runRequest={runRequest}
  stripMode={stripMode}
  awaitingModel={awaitingModel}
  runStatusNow={runStatusNow}
  memoryProposalLocation={memoryProposalLocation}
  memoryProposals={memoryProposals}
  onMemoryProposalResolved={onMemoryProposalResolved}
  navigateTo={navigateTo}
  stoppedBy={stoppedBy}
  runRequestRef={runRequestRef}
  runError={runError}
  compactNow={compactNow}
  compacting={compacting}
  sidePaneIdRef={sidePaneIdRef}
  paneSessionIdRef={paneSessionIdRef}
  coworkPane={coworkPane}
/>

          <CoworkComposerArea
  paneChrome={paneChrome}
  folder={folder}
  recoveryHiddenHere={recoveryHiddenHere}
  worktree={worktree}
  session={session}
  effective={effective}
  foundWorktrees={foundWorktrees}
  coworkSessionIds={coworkSessionIds}
  heldWorktreePaths={heldWorktreePaths}
  setRecoveryHiddenHere={setRecoveryHiddenHere}
  serviceHub={serviceHub}
  setFoundWorktrees={setFoundWorktrees}
  changeCounts={changeCounts}
  openRail={openRail}
  running={running}
  fileDiffs={fileDiffs}
  sandboxApply={sandboxApply}
  autoWorktree={autoWorktree}
  capabilityState={capabilityState}
  handleSubmit={handleSubmit}
  treeRoot={treeRoot}
  stripMode={stripMode}
  barsSheetOpen={barsSheetOpen}
  setBarsSheetOpen={setBarsSheetOpen}
  setBarsSummary={setBarsSummary}
  waitingIds={waitingIds}
  barsSummary={barsSummary}
  gitBranch={gitBranch}
  phoneStrip={phoneStrip}
  projectInitOpen={projectInitOpen}
  setProjectInitOpen={setProjectInitOpen}
  projectInitRoot={projectInitRoot}
  projectInitOffered={projectInitOffered}
  setInstructionsVersion={setInstructionsVersion}
  coworkPane={coworkPane}
  composerModel={composerModel}
  confirmSessionModel={confirmSessionModel}
  applyFolders={applyFolders}
  attachFolder={attachFolder}
  referenceSources={referenceSources}
  slashBuiltins={slashBuiltins}
  handleStop={handleStop}
  currentRunId={currentRunId}
  handleStopAll={handleStopAll}
  tokenSource={tokenSource}
  compactNowRef={compactNowRef}
  paneSessionIdRef={paneSessionIdRef}
  belowComposerControls={belowComposerControls}
  quietModelSelector={quietModelSelector}
  showComposerRailButtons={showComposerRailButtons}
  phone={phone}
  railToolbar={railToolbar}
/>
          </FrameBody>
        </Frame>

        {view === 'details' && (
          <div
            className={cn(
              'flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto py-3',
              // As a page its scrollbar sits on the pane edge, past the shell's
              // 12px gutter (-mr-3), the gutter moving inside as padding; in a
              // split pane the scroller already ends at the pane's edge.
              paneChrome ? 'px-1' : '-mr-3 pr-4 pl-1'
            )}
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
            root={rail.root ?? workspacePath}
            path={rail.path}
            onClose={closeRail}
            // Open while there is nothing to preview; folded over a file.
            verify={
              session?.id ? (
                <BrowserVerifyPanel sessionId={session.id} defaultOpen={!rail.path} />
              ) : undefined
            }
          />
        )}
        {rail?.kind === 'diff' && (
          <CoworkDiffRail
            sessionId={session?.id}
            sessionRemote={!!session?.remote}
            folder={folder}
            worktree={worktree}
            git={git}
            onSendPrompt={(text) => widgetHost.sendPrompt(text)}
            reviewFocusTaskId={reviewFocusTaskId}
            writeGrant={liveGrant?.grantId}
            running={running}
            hasCheckpoints={!!checkpointChain}
            treeRoot={treeRoot}
            access={effective.access}
            janAuthored={
              runOrigins?.summary ? janAuthoredPaths(runOrigins.summary) : []
            }
            gitBranch={gitBranch}
            fileDiffs={fileDiffs}
            openToolPath={openToolPath}
            workspacePath={workspacePath}
            applyFolders={applyFolders}
            sandboxApply={sandboxApply}
            displayToolPath={displayToolPath}
            resolveToolPath={resolveToolPath}
            pathLinkRoots={pathLinkRoots}
            origins={runOrigins?.entries}
            focusPath={rail.focusPath}
            onClose={closeRail}
          />
        )}
        {rail?.kind === 'tasks' && (
          <ReviewChangesContext.Provider value={reviewChildChanges}>
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
          </ReviewChangesContext.Provider>
        )}
        {rail?.kind === 'background' && session?.id && (
          <ReviewChangesContext.Provider value={reviewChildChanges}>
          <CoworkBackgroundTasksPanel
            sessionId={session.id}
            running={backgroundTasks.running}
            finished={backgroundTasks.finished}
            agentReachable={agentReachable}
            onCancelTask={cancelTask}
            onDismiss={(task) =>
              useCoworkActivity.getState().clearBackground({ id: task.id })
            }
            onClearFinished={() =>
              useCoworkActivity
                .getState()
                .clearBackground({ sessionId: session.id })
            }
            onClose={closeRail}
          />
          </ReviewChangesContext.Provider>
        )}
        {rail?.kind === 'browser' && session?.id && (
          // The agent's own browser, as a tab of the output panel: a window like
          // the in-app preview, read-only, opened by the agent's first page and
          // gone when its browser closes.
          <CoworkSidePanel
            title={t('common:browserToolMirror.title')}
            data-testid="cowork-agent-browser-panel"
            onClose={closeRail}
          >
            <div className="flex h-full min-h-0 flex-col p-3">
              <AgentBrowserWindow
                sessionId={session.id}
                className="min-h-[320px] flex-1"
              />
            </div>
          </CoworkSidePanel>
        )}
        {rail?.kind === 'timeline' && session?.id && (
          <CoworkTimelinePanel
            sessionId={session.id}
            running={running}
            onClose={closeRail}
          />
        )}
        {rail?.kind === 'code' && session?.id && (
          <CoworkCodeRail
            sessionId={session.id}
            codePanel={session.codePanel}
            turns={displayedTurns}
            folder={folder}
            treeRoot={treeRoot}
            workspacePath={workspacePath}
            extraFolders={extraFolders}
            destination={effective.destination}
            relativeIsProject={relativeIsProject}
            writeGrant={liveGrant?.grantId}
            sandboxApply={sandboxApply}
            fileDiffs={fileDiffs}
            git={git}
            onAttachFolder={() => void attachFolder()}
            onAddToChat={addCodeToChat}
            onClose={closeRail}
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
