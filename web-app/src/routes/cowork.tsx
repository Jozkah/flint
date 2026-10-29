import { promptReplaceModels } from '@/hooks/useModelReplacePrompt'
import { modelKey, unavailableModels } from '@/lib/modelReplace'
import { markConversationOpened } from '@/lib/messageEntry'
import { useRemoteComposer } from '@/lib/remote/composer'
import { AgentBrowserWindow } from '@/containers/AgentBrowserWindow'
import { BrowserVerifyPanel } from '@/containers/BrowserVerifyPanel'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { type WidgetHost } from '@/lib/visualize/hostContext'
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
  useMemo,
  useRef,
  useState,
} from 'react'
import { cn } from '@/lib/utils'
import { ArrowLeft } from 'lucide-react'
import { Frame, FrameBody } from '@/components/ui/frame'
import { Button } from '@/components/ui/button'
import {
  CoworkInspectorFrame,
  CoworkInspectorProvider,
  CoworkSidePanel,
} from '@/containers/CoworkSidePanel'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { resolveCoworkModel } from '@/lib/coworkModelChoice'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import type { CoworkTurn } from '@/types/coworkSession'
import { PageHeaderRow } from '@/containers/PageHeaderRow'
import { useModelProvider } from '@/hooks/useModelProvider'
import { selectionForThreadModel } from '@/hooks/useConversationPane'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import { useCoworkActiveWork, type WorkKind } from '@/hooks/useCoworkActiveWork'
import { DirectEditConfirmDialog } from '@/containers/dialogs/DirectEditConfirmDialog'
import { modeOf } from '@/lib/coworkMode'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { CoworkPinnedProgress } from '@/containers/CoworkPinnedProgress'
import { CoworkSessionDetails } from '@/containers/CoworkSessionDetails'
import { usePrompt } from '@/hooks/usePrompt'
import { type PromptSnapshotRef } from '@/lib/providerFetch'
import { type SubmittedFile } from '@/lib/coworkAttachments'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import {
  NO_SESSION,
  useCoworkView,
  type CoworkRail,
} from '@/hooks/useCoworkView'
import { awaitsModel } from '@/lib/agentActivity'
import { CoworkPreviewPanel } from '@/containers/CoworkPreviewPanel'
import { CoworkTranscript } from '@/containers/CoworkTranscript'
import { CoworkCodeRail } from '@/containers/CoworkCodeRail'
import { CoworkComposerArea } from '@/containers/CoworkComposerArea'
import { CoworkDiffRail } from '@/containers/CoworkDiffRail'
import { CoworkTasksPanel } from '@/containers/CoworkTasksPanel'
import { CoworkBackgroundTasksPanel } from '@/containers/CoworkBackgroundTasksPanel'
import { ReviewChangesContext } from '@/containers/TaskCheckoutLink'
import { CoworkTimelinePanel } from '@/containers/CoworkTimelinePanel'
import type { LiveJob } from '@/lib/coworkTasks'
import { type CodeRef } from '@/lib/coworkCode'
import {
  extraFoldersOf,
  mainFolderReadOnlyOf,
  writableExtraFoldersOf,
} from '@/lib/coworkFolders'
import { type RailMode } from '@/containers/CoworkRailToolbar'
import { useCoworkGitStatus } from '@/hooks/useCoworkGitStatus'
import { janAuthoredPaths } from '@/lib/coworkOrigins'
import { useRegisterHostedSession } from '@/lib/coworkHosting'
import { useCampaignLaunchSend } from '@/hooks/useCampaignLaunchSend'
import { useShallow } from 'zustand/react/shallow'
import {
  recoveryHidden,
  } from '@/lib/coworkWorktrees'
import { useSkills } from '@/hooks/useSkills'
import {
  accessOf,
  effectiveAccess,
  type AccessMode,
} from '@/lib/coworkAccess'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import { type ContextAccounting, type InstructionFile } from '@/lib/coworkReadiness'
import { CoworkChatTransport } from '@/lib/coworkTransport'
import { runCoworkRequest, type RunRequestArgs } from '@/lib/cowork/run/runRequest'
import {
  useCoworkWorktrees,
  type WorktreeRecord,
} from '@/hooks/useCoworkWorktrees'
import { useAutoSessionWorktree } from '@/hooks/useAutoSessionWorktree'
import { type RunOutcome } from '@/lib/coworkRunner'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import {
  allowedRemoteModes,
  serverPageMode,
  useRemoteCowork,
  useRunnerInfo,
} from '@/lib/remoteCowork'
import { isServerTransport } from '@/lib/serverTransportFlag'
import { type LoadedTooling } from '@/lib/projectTooling'
import { runStatus } from '@/lib/runStatus'
import {
  EMPTY_SUMMARY,
  attentionCount,
  type NarrowBarsSummary,
} from '@/containers/NarrowStatusStrip'
import { useMemoryProposals } from '@/hooks/useMemoryProposals'
import { useCoworkFolderActions } from '@/hooks/cowork/useCoworkFolderActions'
import { useCoworkFolderScans } from '@/hooks/cowork/useCoworkFolderScans'
import { useCoworkPathActions } from '@/hooks/cowork/useCoworkPathActions'
import { useCoworkViewState } from '@/hooks/cowork/useCoworkViewState'
import { useCoworkRunActions } from '@/hooks/cowork/useCoworkRunActions'
import { useCoworkActivityPanel } from '@/hooks/cowork/useCoworkActivityPanel'
import { useCoworkEditAuthority } from '@/hooks/cowork/useCoworkEditAuthority'
import { useCoworkTranscript } from '@/hooks/cowork/useCoworkTranscript'
import { useCoworkChrome } from '@/hooks/cowork/useCoworkChrome'
import { useCoworkSessionContext } from '@/hooks/cowork/useCoworkSessionContext'


export const Route = createFileRoute(route.cowork)({
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

/** Stable empty lane, so a session with no run does not re-render per write. */
const NO_LIVE_TURNS: CoworkTurn[] = []





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
  const {
    workspacePath,
    setSubagentDefs,
    sessionIdRef,
    runOrigins,
    liveUsage,
    compat,
    runSkillsRef,
    subagentDefs,
    readiness,
    settingsMcpServers,
    rendererReports,
    mcpProbes,
    setMcpConsent,
    skillRoots,
    janDataFolder,
    rescanCompat,
    sessionDetailsSummary,
    browserReports,
    referenceSources,
  } = useCoworkSessionContext({
    folder,
    setFoundWorktrees,
    serviceHub,
    session,
    availableSkills,
    enabledSkills,
    advertisedToolNames,
    selectedModel,
    selectedProvider,
    getProviderByName,
    modelCapabilities,
    transportRef,
    runContext,
    mode,
    extraFolders,
    effective,
    worktree,
    gitBranch,
    projectInstructions,
    tooling,
    instructionFiles,
    advertisedToolCount,
    composerPrompt,
    viewedId,
  })
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
  const {
    originOfPath,
    recordOrigins,
    setLastPreviewPath,
    setLastPreviewRoot,
    openToolPath,
    selectRail,
    checkToolPath,
    toolPathExists,
    openToolDiff,
    displayToolPath,
    pathLinkRoots,
    showPreview,
    openSummaryPath,
    resolveToolPath,
    relativeIsProject,
  } = useCoworkPathActions({
    paneSessionIdRef,
    setRail,
    effective,
    folder,
    liveGrant,
    treeRoot,
    workspacePath,
    extraFolders,
    session,
    t,
    serviceHub,
    rail,
  })
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
  useCoworkFolderScans({
    setSubagentDefs,
    folder,
    setGitBranch,
    setTooling,
    setInstructionFiles,
    setProjectInstructions,
    sessionIdRef,
    serviceHub,
    instructionsVersion,
  })

  // Selected-code references staged by “Add to chat”: the visible prompt gets
  // the concise `@path:start-end` token, and the refs wait here until submit,
  // when the model's copy of the message is expanded with the selected text.
  const pendingRefs = useRef<CodeRef[]>([])
  const {
    attachFolder,
    detachFolder,
    setFolderWritable,
    addExtraFolder,
    removeExtraFolder,
    addCodeToChat,
  } = useCoworkFolderActions({
    pendingRefs,
    session,
    folder,
    t,
    serviceHub,
    paneSessionIdRef,
    setPendingFolder,
    setPendingAccess,
  })
  const {
    fileDiffs,
    displayedTurns,
    windowStart,
    setEarlierShown,
    earlierPages,
    messageWeights,
    uiMessages,
    snapshotByAnchor,
    setRevealHiddenTools,
    snapshotByMessageId,
    runOutcome,
    tokenSource,
    checkpointChain,
  } = useCoworkTranscript({
    session,
    running,
    liveTurns,
    stoppedBy,
    runError,
    runOrigins,
    liveUsage,
    workspacePath,
  })

  // Read-only working-tree status for the attached repo, loaded lazily and kept
  // strictly separate from the sandbox diffs above. The chip's counts combine
  // both sources so it appears whenever either has changes.
  // Re-read when a run starts or settles: a run's edits, commits and undo
  // change the tree, and a list loaded before them contradicts its own diffs.
  const git = useCoworkGitStatus(treeRoot, running)
  const {
    authorizeManagedWorktree,
    authorizeDirectEdit,
    returnToReviewOnly,
    changeCounts,
    showPromptSnapshot,
    sandboxApply,
    directEditFacts,
  } = useCoworkEditAuthority({
    session,
    git,
    folder,
    workspacePath,
    applyFolders,
    setPendingAccess,
    setConfirmDirectEdit,
    effective,
    serviceHub,
    writableExtraFolders,
    bindingRef,
    access,
    liveGrant,
    capabilityState,
    mainFolderReadOnly,
    t,
    gitBranch,
    mode,
    fileDiffs,
  })

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
  const {
    taskCounts,
    backgroundTasks,
    activity,
    activityNow,
    showTaskInPanel,
    showWorkflowInPanel,
    reviewFocusTaskId,
    reviewChildChanges,
    workflowViews,
    focusWorkflowId,
    focusTaskId,
    setFocusTaskId,
    setFocusWorkflowId,
    agentReachable,
    cancelTask,
    cancelWorkflowTasks,
  } = useCoworkActivityPanel({
    session,
    rail,
    setRail,
    liveJobsSession,
    liveJobs,
    t,
  })

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
   * Drive one request (lib/cowork/run/runRequest.ts). The page's values are
   * read when the request starts, as the closure this replaced did.
   */
  const runRequest = (...args: RunRequestArgs) =>
    runCoworkRequest(
      {
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
      },
      ...args
    )

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
  const {
    setCompacting,
    handleStop,
    handleRegenerate,
    respondAsk,
    compactNow,
    compacting,
    slashBuiltins,
    currentRunId,
    handleStopAll,
    compactNowRef,
  } = useCoworkRunActions({
    session,
    running,
    selectedModel,
    selectedProvider,
    modelCapabilities,
    t,
    runRequestRef,
    handleSubmit,
    sidePaneIdRef,
    paneSessionIdRef,
  })
  const {
    revealOutput,
    phone,
    narrow,
    view,
    closeRail,
    agentBrowserOpen,
    compactRun,
    paneChrome,
    showView,
    compactViews,
    openRail,
    phoneStrip,
  } = useCoworkViewState({
    running,
    session,
    runRequestRef,
    transcriptRef,
    lastSnapshotRef,
    setLastPreviewPath,
    setLastPreviewRoot,
    workspacePath,
    setRail,
    attachFolder,
    openToolPath,
    rail,
  })
  const {
    runningChip,
    serverModelChip,
    progressButton,
    headerStop,
    showComposerRailButtons,
    outputToggle,
    viewSwitch,
    detailsBody,
    workspacePill,
    inspectorLayout,
    projectInitRoot,
    projectInitOffered,
    belowComposerControls,
    quietModelSelector,
    railToolbar,
    inspectorVisible,
    panelShown,
  } = useCoworkChrome({
    selectRail,
    revealOutput,
    rail,
    session,
    phone,
    narrow,
    view,
    activeRail,
    t,
    closeRail,
    agentBrowserOpen,
    changeCounts,
    taskCounts,
    backgroundTasks,
    paneSessionIdRef,
    treeRoot,
    instructionFiles,
    setProjectInitOpen,
    folder,
    workspacePath,
    gitBranch,
    attachFolder,
    detachFolder,
    effective,
    extraFolders,
    capabilityState,
    setFolderWritable,
    mainFolderReadOnly,
    addExtraFolder,
    removeExtraFolder,
    mode,
    modeOptions,
    setConfirmDirectEdit,
    running,
    blockingKind,
    setPendingAccess,
    authorizeManagedWorktree,
    returnToReviewOnly,
    compactRun,
    paneChrome,
    readiness,
    settingsMcpServers,
    selectedProvider,
    getProviderByName,
    selectedModel,
    serviceHub,
    rendererReports,
    runContext,
    compat,
    mcpProbes,
    setMcpConsent,
    skillRoots,
    janDataFolder,
    rescanCompat,
    showView,
    handleStop,
  })

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
