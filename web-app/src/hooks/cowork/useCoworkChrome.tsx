import type { ComponentReport } from '@janhq/tauri-plugin-agent-tools-api'
import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  Info,
  Loader2,
  MessageSquare,
  PanelRight,
} from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { Button } from '@/components/ui/button'
import { type CoworkPhoneView } from '@/hooks/cowork/useCoworkLayout'
import { type InspectorLayout } from '@/containers/CoworkSidePanel'
import { useCoworkSessions, ensureCurrentSession } from '@/hooks/useCoworkSessions'
import { confirmBypass } from '@/lib/bypassConfirm'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { formatChangeSummary } from '@/lib/coworkChangeSummary'
import { CoworkWorkspacePill } from '@/containers/CoworkWorkspacePill'
import { CoworkModeSelector } from '@/containers/CoworkModeSelector'
import {
  CoworkRunSettings,
  type RunSettingsException,
} from '@/containers/CoworkRunSettings'
import { CoworkAccessSelector } from '@/containers/CoworkAccessSelector'
import { type WorkKind } from '@/hooks/useCoworkActiveWork'
import { workProfile } from '@/lib/workProfiles'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { CoworkProgressButton } from '@/containers/CoworkPinnedProgress'
import { CoworkDetailsBody } from '@/containers/CoworkDetailsBody'
import {
  CoworkRailToolbar,
  type RailMode,
} from '@/containers/CoworkRailToolbar'
import { projectInitLabel, useProjectInitDrafts } from '@/lib/projectInit'
import { accessShortLabelKey, type AccessMode } from '@/lib/coworkAccess'
import { type ContextAccounting, type InstructionFile } from '@/lib/coworkReadiness'
import { useCoworkParallel } from '@/hooks/useCoworkParallel'
import { isRemoteSession, setRemoteMode } from '@/lib/remoteCowork'
import { setRunModel } from '@/lib/remoteRunner'
import { isServerTransport } from '@/lib/serverTransportFlag'
import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import { CoworkWorkProfilePicker } from '@/containers/CoworkWorkProfilePicker'
import { CoworkRunChip } from '@/containers/CoworkRunChip'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { ChangeCounts } from '@/lib/coworkChangeSummary'
import type { ActivityProgress } from '@/lib/coworkActivity'
import type { ActivityTask } from '@/lib/coworkActivity'
import type { RefObject } from 'react'
import type { Dispatch } from 'react'
import type { SetStateAction } from 'react'
import type { EffectiveAccess } from '@/lib/coworkAccess'
import type { CapabilityState } from '@/hooks/useDirectEditGrants'
import type { CoworkMode } from '@/lib/coworkMode'
import type { PaneChrome } from '@/hooks/useCoworkPane'
import type { ReadinessManifest } from '@/lib/coworkReadiness'
import type { ServiceHub } from '@/services'
import type { CompatibilityManifest } from '@/lib/claudeCompat'
import type { McpProbe } from '@/lib/claudeCompat'

/** Below 768px Cowork shows one of these at a time. */
const PHONE_VIEWS: readonly CoworkPhoneView[] = ['content', 'output', 'details']

export type CoworkChromeArgs = {
  selectRail: (mode: RailMode) => void
  revealOutput: () => void
  rail: { kind: "preview"; path?: string; root?: string; } | { kind: "diff"; focusPath?: string; } | { kind: "code"; } | { kind: "tasks"; } | { kind: "timeline"; } | { kind: "browser"; } | { kind: "background"; } | null
  session: CoworkSession | null
  phone: boolean
  narrow: boolean
  view: CoworkPhoneView
  activeRail: RailMode | null
  t: (key: string, options?: Record<string, unknown>) => string
  closeRail: () => void
  agentBrowserOpen: boolean
  changeCounts: ChangeCounts
  taskCounts: ActivityProgress
  backgroundTasks: { running: ActivityTask[]; finished: ActivityTask[]; }
  paneSessionIdRef: RefObject<string | undefined>
  treeRoot: string | null
  instructionFiles: InstructionFile[]
  setProjectInitOpen: Dispatch<SetStateAction<boolean>>
  folder: string | null
  workspacePath: string | null
  gitBranch: string | null
  attachFolder: (given?: string) => Promise<void>
  detachFolder: () => Promise<void>
  effective: EffectiveAccess
  extraFolders: string[]
  capabilityState: CapabilityState
  setFolderWritable: (target: string | null, writable: boolean) => Promise<void>
  mainFolderReadOnly: boolean
  addExtraFolder: () => Promise<void>
  removeExtraFolder: (extra: string) => Promise<void>
  mode: CoworkMode
  modeOptions: CoworkMode[] | undefined
  setConfirmDirectEdit: Dispatch<SetStateAction<boolean>>
  running: boolean
  blockingKind: WorkKind | null
  setPendingAccess: Dispatch<SetStateAction<Record<string, AccessMode>>>
  authorizeManagedWorktree: () => Promise<boolean>
  returnToReviewOnly: () => Promise<void>
  compactRun: boolean
  paneChrome: PaneChrome | null
  readiness: ReadinessManifest
  settingsMcpServers: number
  selectedProvider: string
  getProviderByName: (providerName: string) => ModelProvider | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the store's own type
  selectedModel: any
  serviceHub: ServiceHub
  rendererReports: ComponentReport[]
  runContext: ContextAccounting | null
  compat: CompatibilityManifest
  mcpProbes: readonly McpProbe[]
  setMcpConsent: (probe: McpProbe, allowed: boolean) => Promise<void>
  skillRoots: string[]
  janDataFolder: string | null
  rescanCompat: () => void
  showView: (next: CoworkPhoneView) => void
  handleStop: () => void
}

export function useCoworkChrome({
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
}: CoworkChromeArgs) {
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
  return {
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
  }
}
