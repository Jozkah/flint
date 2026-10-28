import type { ComponentProps } from 'react'
import ChatInput from '@/containers/ChatInput'
import { type SandboxApplyActions } from '@/containers/CoworkApplyAllDialog'
import { CoworkBarStack } from '@/containers/CoworkBarStack'
import { CoworkHandoffNotice } from '@/containers/CoworkHandoffNotice'
import { CoworkProjectInit } from '@/containers/CoworkProjectInit'
import { CoworkReviewReady } from '@/containers/CoworkReviewReady'
import { CoworkSandboxChip } from '@/containers/CoworkSandboxChip'
import { CoworkSessionWorktreeBar } from '@/containers/CoworkSessionWorktreeBar'
import { CoworkStopMenu } from '@/containers/CoworkStopMenu'
import { CoworkWorktreeRecovery } from '@/containers/CoworkWorktreeRecovery'
import { FolderTrustBanner } from '@/containers/FolderTrustBanner'
import { JevSkillSuggestion } from '@/containers/JevSkillSuggestion'
import { NarrowBarsSheet, type NarrowBarsSummary, NarrowStatusStrip } from '@/containers/NarrowStatusStrip'
import { PrBar } from '@/containers/PrBar'
import { SharedFolderBar } from '@/containers/SharedFolderBar'
import { SharedFolderIsolationHint } from '@/containers/SharedFolderIsolationHint'
import SkillSelector from '@/containers/SkillSelector'
import { useCoworkParallel } from '@/hooks/useCoworkParallel'
import { ensureCurrentSession, useCoworkSessions } from '@/hooks/useCoworkSessions'
import { type CoworkRail } from '@/hooks/useCoworkView'
import { type WorktreeRecord, useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import { coworkWebSearchScope } from '@/hooks/useWebSearchChoice'
import { scrollToApproval } from '@/lib/approvalDestination'
import { effectiveDowngradeKey } from '@/lib/coworkAccess'
import { type SubmittedFile } from '@/lib/coworkAttachments'
import { hideRecovery, recoverableWorktrees, sessionWorktreeBranch } from '@/lib/coworkWorktrees'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { CoworkPane, PaneChrome } from '@/hooks/useCoworkPane'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { CapabilityState } from '@/hooks/useDirectEditGrants'
import type { EffectiveAccess } from '@/lib/coworkAccess'
import type { ChangeCounts } from '@/lib/coworkChangeSummary'
import type { CoworkFileDiff } from '@/lib/coworkDiffs'
import type { SlashBuiltin } from '@/lib/slashCommands'
import type { SpeedSource } from '@/lib/tokenSpeed'
import type { TokenUsage } from '@/lib/tokenUsage'
import type { ServiceHub } from '@/services'
import type { Dispatch, JSX, RefObject, SetStateAction } from 'react'

type CoworkComposerAreaProps = {
  paneChrome: PaneChrome | null
  folder: string | null
  recoveryHiddenHere: boolean
  worktree: WorktreeRecord | undefined
  session: CoworkSession | null
  effective: EffectiveAccess
  foundWorktrees: WorktreeRecord[]
  coworkSessionIds: string[]
  heldWorktreePaths: string[]
  setRecoveryHiddenHere: Dispatch<SetStateAction<boolean>>
  serviceHub: ServiceHub
  setFoundWorktrees: Dispatch<SetStateAction<WorktreeRecord[]>>
  changeCounts: ChangeCounts
  openRail: (next: CoworkRail) => void
  running: boolean
  fileDiffs: CoworkFileDiff[]
  sandboxApply: SandboxApplyActions | undefined
  autoWorktree: { isGit: boolean | null; workOnCopy: () => Promise<void>; isolationReason: "fork" | "secondSession" | null; choseShared: boolean; chooseShared: () => Promise<void>; }
  capabilityState: CapabilityState
  handleSubmit: (text: string, files?: SubmittedFile[], onRefused?: () => void) => void
  treeRoot: string | null
  stripMode: boolean
  barsSheetOpen: boolean
  setBarsSheetOpen: Dispatch<SetStateAction<boolean>>
  setBarsSummary: Dispatch<SetStateAction<NarrowBarsSummary>>
  waitingIds: string[]
  barsSummary: NarrowBarsSummary
  gitBranch: string | null
  phoneStrip: boolean
  projectInitOpen: boolean
  setProjectInitOpen: Dispatch<SetStateAction<boolean>>
  projectInitRoot: string | null
  projectInitOffered: boolean
  setInstructionsVersion: Dispatch<SetStateAction<number>>
  coworkPane: CoworkPane | null
  composerModel: {
    selection: ComponentProps<typeof ChatInput>['modelSelection']
    unavailable: ComponentProps<typeof ChatInput>['unavailableModel']
  }
  confirmSessionModel: () => Promise<{ status: "stop"; modelId?: undefined; } | { status: "retry"; modelId: string; }> | { status: "ok"; }
  applyFolders: string[]
  attachFolder: (given?: string) => Promise<void>
  referenceSources: { skills: { name: string; description: string; }[]; agents: { name: string; description: string; }[]; }
  slashBuiltins: SlashBuiltin[]
  handleStop: () => void
  currentRunId: string | undefined
  handleStopAll: () => void
  tokenSource: { threadId: string | undefined; usage: TokenUsage | undefined; contextError: string | undefined; session: TokenUsage | undefined; loadingModel: boolean; speed: { last?: number; average?: number; source?: SpeedSource; samples?: number; }; }
  compactNowRef: RefObject<(opts?: { thenContinue?: boolean; }) => Promise<void>>
  paneSessionIdRef: RefObject<string | undefined>
  belowComposerControls: JSX.Element
  quietModelSelector: JSX.Element
  showComposerRailButtons: boolean
  phone: boolean
  railToolbar: (presentation: "toolbar" | "tabs") => JSX.Element
}

export function CoworkComposerArea({
  paneChrome,
  folder,
  recoveryHiddenHere,
  worktree,
  session,
  effective,
  foundWorktrees,
  coworkSessionIds,
  heldWorktreePaths,
  setRecoveryHiddenHere,
  serviceHub,
  setFoundWorktrees,
  changeCounts,
  openRail,
  running,
  fileDiffs,
  sandboxApply,
  autoWorktree,
  capabilityState,
  handleSubmit,
  treeRoot,
  stripMode,
  barsSheetOpen,
  setBarsSheetOpen,
  setBarsSummary,
  waitingIds,
  barsSummary,
  gitBranch,
  phoneStrip,
  projectInitOpen,
  setProjectInitOpen,
  projectInitRoot,
  projectInitOffered,
  setInstructionsVersion,
  coworkPane,
  composerModel,
  confirmSessionModel,
  applyFolders,
  attachFolder,
  referenceSources,
  slashBuiltins,
  handleStop,
  currentRunId,
  handleStopAll,
  tokenSource,
  compactNowRef,
  paneSessionIdRef,
  belowComposerControls,
  quietModelSelector,
  showComposerRailButtons,
  phone,
  railToolbar,
}: CoworkComposerAreaProps) {
  const { t } = useTranslation()
  return (
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
          {/* Whether a folder's own hooks and agents may run: asked here,
              over the composer, so it cannot scroll away. Outside the
              stack so it never pushes the session's own bars behind
              "Show N more". */}
          {(() => {
            const bars = (
              <>
          <FolderTrustBanner folder={folder} />
          {/* The bars over the composer stack: two at a time, the rest
              behind "Show N more". */}
          <CoworkBarStack max={Infinity}>
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
              <>
              <SharedFolderIsolationHint
                reason={autoWorktree.isolationReason}
                choseShared={autoWorktree.choseShared}
                onUseShared={() => void autoWorktree.chooseShared()}
              />
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
              </>
            ) : null}
            <PrBar folder={treeRoot ?? folder} sessionId={session?.id} className="mb-2" />
            {/* Other sessions in this folder: one more bar, so the narrow
                strip folds it in with the rest. Nothing when alone. */}
            <SharedFolderBar
              sessionId={session?.id}
              onOpenSession={(id) => useCoworkSessions.getState().selectSession(id)}
            />
          </CoworkBarStack>
              </>
            )
            return (
              <>
                <NarrowBarsSheet
                  inline={!stripMode}
                  open={barsSheetOpen && stripMode}
                  onOpenChange={setBarsSheetOpen}
                  onSummary={setBarsSummary}
                >
                  {bars}
                </NarrowBarsSheet>
                {stripMode && (
                <NarrowStatusStrip
                  waiting={waitingIds.length}
                  summary={barsSummary}
                  files={{
                    count: changeCounts.fileCount,
                    additions: changeCounts.additions,
                    deletions: changeCounts.deletions,
                  }}
                  branch={worktree?.branch ?? gitBranch ?? null}
                  onWaiting={() => {
                    if (waitingIds[0]) void scrollToApproval(waitingIds[0])
                  }}
                  onOpen={() => setBarsSheetOpen((v) => !v)}
                  condensed={phoneStrip}
                />
                )}
              </>
            )
          })()}
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
            // A pasted folder path offers to attach it as the project.
            pastedFolder={{
              attached: applyFolders,
              onAttach: (path) => void attachFolder(path),
            }}
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
            // Web search is per session; a choice made before the first
            // message creates the session it belongs to, like the mode.
            webSearchScope={
              session?.id ? coworkWebSearchScope(session.id) : null
            }
            ensureWebSearchScope={() =>
              coworkWebSearchScope(
                ensureCurrentSession(paneSessionIdRef.current)
              )
            }
            // Under the composer, as Claude lays it out: what the run may
            // do on the left; the effort and the model on the right.
            // A split pane uses the same row (its folder included).
            belowLeft={belowComposerControls}
            // Below the input in every layout, a split pane included: each
            // pane picks its own session's model there, never the global one.
            modelControl={quietModelSelector}
            surfaceControls={
              <>
                <CoworkSandboxChip />
                {/* On a phone the composer is out of view while the
                    output is, so it keeps one set there. */}
                {/* On a phone the box keeps only attach, options and
                    skills: the views are one tap away in the view switch. */}
                {showComposerRailButtons &&
                  !phone &&
                  railToolbar('toolbar')}
                <div className="ml-auto flex items-center">
                  <SkillSelector folder={folder} />
                </div>
              </>
            }
          />
        </div>
      </div>
  )
}
