import { promptReplaceModels } from '@/hooks/useModelReplacePrompt'
import { modelKey, unavailableModels } from '@/lib/modelReplace'
import { markConversationOpened } from '@/lib/messageEntry'
import { useRemoteComposer } from '@/lib/remote/composer'
import { AgentBrowserWindow } from '@/containers/AgentBrowserWindow'
import { BrowserVerifyPanel } from '@/containers/BrowserVerifyPanel'
import { useBrowserVerify } from '@/hooks/useBrowserVerify'
import type { VerifyReport } from '@/lib/browserVerify'
import { currentDoctorResult, observedToolsFact, useModelDoctor } from '@/hooks/useModelDoctor'
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
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  ArrowLeft,
  Info,
  Loader2,
  MessageSquare,
  PanelRight,
} from 'lucide-react'
import { Frame, FrameBody } from '@/components/ui/frame'
import { Chip } from '@/components/ui/chip'
import { Button } from '@/components/ui/button'
import { type CoworkPhoneView } from '@/hooks/cowork/useCoworkLayout'
import {
  CoworkInspectorFrame,
  CoworkInspectorProvider,
  CoworkSidePanel,
  type InspectorLayout,
} from '@/containers/CoworkSidePanel'
import { useCoworkSessions, ensureCurrentSession } from '@/hooks/useCoworkSessions'
import { useSessionWorkspacePath } from '@/hooks/useSessionWorkspacePath'
import { resolveCoworkModel } from '@/lib/coworkModelChoice'
import { confirmBypass } from '@/lib/bypassConfirm'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import type { CoworkTurn, Usage } from '@/types/coworkSession'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import { PageHeaderRow } from '@/containers/PageHeaderRow'
import { useModelProvider } from '@/hooks/useModelProvider'
import { selectionForThreadModel } from '@/hooks/useConversationPane'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'
import { formatChangeSummary } from '@/lib/coworkChangeSummary'
import { useAppState } from '@/hooks/useAppState'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import { CoworkWorkspacePill } from '@/containers/CoworkWorkspacePill'
import { CoworkModeSelector } from '@/containers/CoworkModeSelector'
import {
  CoworkRunSettings,
  type RunSettingsException,
} from '@/containers/CoworkRunSettings'
import { CoworkAccessSelector } from '@/containers/CoworkAccessSelector'
import { useCoworkOrigins } from '@/hooks/useCoworkOrigins'
import { useCoworkActiveWork, type WorkKind } from '@/hooks/useCoworkActiveWork'
import { DirectEditConfirmDialog } from '@/containers/dialogs/DirectEditConfirmDialog'
import { modeOf } from '@/lib/coworkMode'
import { workProfile } from '@/lib/workProfiles'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import {
  CoworkPinnedProgress,
  CoworkProgressButton,
} from '@/containers/CoworkPinnedProgress'
import { CoworkSessionDetails } from '@/containers/CoworkSessionDetails'
import { rendererReadinessReports } from '@/lib/coworkRendererReadiness'
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
import { configuredContextTokens } from '@/lib/coworkContextWindow'
import { useCoworkReadiness } from '@/hooks/useCoworkReadiness'
import { CoworkTranscript } from '@/containers/CoworkTranscript'
import { CoworkCodeRail } from '@/containers/CoworkCodeRail'
import { CoworkComposerArea } from '@/containers/CoworkComposerArea'
import { CoworkDetailsBody } from '@/containers/CoworkDetailsBody'
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
import {
  CoworkRailToolbar,
  type RailMode,
} from '@/containers/CoworkRailToolbar'
import { useCoworkGitStatus } from '@/hooks/useCoworkGitStatus'
import { janAuthoredPaths } from '@/lib/coworkOrigins'
import { useRegisterHostedSession } from '@/lib/coworkHosting'
import { useCampaignLaunchSend } from '@/hooks/useCampaignLaunchSend'
import { projectInitLabel, useProjectInitDrafts } from '@/lib/projectInit'
import { useShallow } from 'zustand/react/shallow'
import {
  recoveryHidden,
  } from '@/lib/coworkWorktrees'
import { useClaudeCompat } from '@/hooks/useClaudeCompat'
import { useCompatManifest } from '@/hooks/useCompatManifest'
import { useImportedMcp } from '@/hooks/useImportedMcp'
import { effectiveEnabled, useSkills } from '@/hooks/useSkills'
import {
  accessOf,
  accessShortLabelKey,
  effectiveAccess,
  type AccessMode,
} from '@/lib/coworkAccess'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import {
  resolveSkills,
  type ContextAccounting,
  type InstructionFile,
} from '@/lib/coworkReadiness'
import { CoworkChatTransport } from '@/lib/coworkTransport'
import { runCoworkRequest, type RunRequestArgs } from '@/lib/cowork/run/runRequest'
import {
  useCoworkWorktrees,
  type WorktreeRecord,
} from '@/hooks/useCoworkWorktrees'
import { useAutoSessionWorktree } from '@/hooks/useAutoSessionWorktree'
import { useCoworkParallel } from '@/hooks/useCoworkParallel'
import { coworkWebSearchScope, useWebSearchOn } from '@/hooks/useWebSearchChoice'
import { type RunOutcome } from '@/lib/coworkRunner'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import {
  allowedRemoteModes,
  isRemoteSession,
  serverPageMode,
  setRemoteMode,
  useRemoteCowork,
  useRunnerInfo,
} from '@/lib/remoteCowork'
import { setRunModel } from '@/lib/remoteRunner'
import { isServerTransport } from '@/lib/serverTransportFlag'
import { type SubagentDefinition } from '@/lib/coworkSubagentRegistry'
import { type LoadedTooling } from '@/lib/projectTooling'
import { useMCPServers } from '@/hooks/useMCPServers'
import { sessionDetailsLabel } from '@/lib/windowTitle'
import { runStatus } from '@/lib/runStatus'
import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import { CoworkWorkProfilePicker } from '@/containers/CoworkWorkProfilePicker'
import {
  EMPTY_SUMMARY,
  attentionCount,
  type NarrowBarsSummary,
} from '@/containers/NarrowStatusStrip'
import { CoworkRunChip } from '@/containers/CoworkRunChip'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useMemoryProposals } from '@/hooks/useMemoryProposals'
import { useCoworkFolderActions } from '@/hooks/cowork/useCoworkFolderActions'
import { useCoworkFolderScans } from '@/hooks/cowork/useCoworkFolderScans'
import { useCoworkPathActions } from '@/hooks/cowork/useCoworkPathActions'
import { useCoworkViewState } from '@/hooks/cowork/useCoworkViewState'
import { useCoworkRunActions } from '@/hooks/cowork/useCoworkRunActions'
import { useCoworkActivityPanel } from '@/hooks/cowork/useCoworkActivityPanel'
import { useCoworkEditAuthority } from '@/hooks/cowork/useCoworkEditAuthority'
import { useCoworkTranscript } from '@/hooks/cowork/useCoworkTranscript'


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

/** Below 768px Cowork shows one of these at a time. */
const PHONE_VIEWS: readonly CoworkPhoneView[] = ['content', 'output', 'details']



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
