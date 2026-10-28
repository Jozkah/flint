import type { ComponentProps } from 'react'
import type { ResolvedCodePath } from '@/lib/codePathResolve'
import { useServiceHub } from '@/hooks/useServiceHub'
import { RemoteWorktreePanel } from '@/components/server/RemoteWorktreePanel'
import { CoworkBundleImport } from '@/containers/CoworkBundleImport'
import { CoworkDiffPanel } from '@/containers/CoworkDiffPanel'
import { CoworkProposalReview } from '@/containers/CoworkProposalReview'
import { CoworkReviewAction } from '@/containers/CoworkReviewAction'
import { CoworkRewind } from '@/containers/CoworkRewind'
import { CoworkTeamReviews } from '@/containers/CoworkTeamReviews'
import { CoworkTurnUndo } from '@/containers/CoworkTurnUndo'
import { useCoworkCheckpoints } from '@/hooks/useCoworkCheckpoints'
import { absoluteChangePath } from '@/lib/codePathResolve'
import { basenameOf } from '@/lib/coworkPreview'
import { planSandboxApply, sandboxRelativePath } from '@/lib/coworkSandboxApply'
import { errorText } from '@/lib/errorText'
import { toast } from 'sonner'

type PanelProps = ComponentProps<typeof CoworkDiffPanel>

type Props = {
  sessionId: string | undefined
  sessionRemote: boolean
  folder: string | null
  worktree: (ComponentProps<typeof CoworkProposalReview>['worktree'] & { branch?: string }) | null | undefined
  git: PanelProps['git']
  onSendPrompt: (text: string) => boolean
  reviewFocusTaskId: string | null
  writeGrant: string | undefined
  running: boolean
  hasCheckpoints: boolean
  treeRoot: string | null
  access: string
  janAuthored: string[]
  gitBranch: string | null
  fileDiffs: PanelProps['sandboxFiles']
  openToolPath: PanelProps['onOpenFile']
  workspacePath: string | null
  applyFolders: Parameters<typeof planSandboxApply>[1]
  sandboxApply: PanelProps['applyActions']
  displayToolPath: PanelProps['displayPath']
  resolveToolPath: (path: string) => ResolvedCodePath
  pathLinkRoots: string[]
  origins: PanelProps['origins']
  focusPath: PanelProps['focusPath']
  onClose: () => void
}

/** The Changes rail: the run's diff with its review, rewind and import tools. */
export function CoworkDiffRail({
  sessionId,
  sessionRemote,
  folder,
  worktree,
  git,
  onSendPrompt,
  reviewFocusTaskId,
  writeGrant,
  running,
  hasCheckpoints,
  treeRoot,
  access,
  janAuthored,
  gitBranch,
  fileDiffs,
  openToolPath,
  workspacePath,
  applyFolders,
  sandboxApply,
  displayToolPath,
  resolveToolPath,
  pathLinkRoots,
  origins,
  focusPath,
  onClose,
}: Props) {
  const serviceHub = useServiceHub()
  return (
      <CoworkDiffPanel
        // Going back to how things were belongs where what changed is
        // shown: the two questions are asked in the same breath.
        header={
          <>
          {/* An isolated run's work reaches the folder only through a
              reviewed proposal, so the review sits with the changes. */}
          {worktree && sessionId ? (
            <CoworkProposalReview
              worktree={worktree}
              session={sessionId}
              onApplied={() => git.refresh()}
            />
          ) : null}
          {/* A server session's own checkout: merge, discard, review. */}
          {sessionId && sessionRemote ? (
            <RemoteWorktreePanel sessionId={sessionId} />
          ) : null}
          {/* One-command review of the current diff: ranked findings, each
              checked by a second pass; fixes go through the session. */}
          {folder && sessionId ? (
            <CoworkReviewAction
              folder={folder}
              sessionId={sessionId}
              onFix={(text) => onSendPrompt(text)}
            />
          ) : null}
          {/* AH-109: each isolated team child's worktree, for review. */}
          {folder && sessionId ? (
            <CoworkTeamReviews
              project={folder}
              session={sessionId}
              focusTaskId={reviewFocusTaskId}
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
          {sessionId ? (
            <CoworkTurnUndo
              sessionId={sessionId}
              writeGrant={writeGrant}
              refreshKey={running}
              onChanged={() => git.refresh()}
            />
          ) : null}
          <CoworkRewind
            points={
              sessionId && hasCheckpoints
                ? useCoworkCheckpoints
                    .getState()
                    .usable(sessionId, treeRoot)
                : []
            }
            onPlan={(sha) =>
              useCoworkCheckpoints.getState().plan(sessionId ?? '', sha)
            }
            onPreviewDiff={(sha) =>
              useCoworkCheckpoints
                .getState()
                .previewDiff(sessionId ?? '', sha)
            }
            // Newer edits Flint made itself are not someone else's work, so
            // only the rest need an explicit acknowledgement.
            janAuthored={
              janAuthored
            }
            onSafetyCapture={async (label) => {
              if (!sessionId || !treeRoot)
                return { ok: false, reason: 'no working tree' }
              const saved = await useCoworkCheckpoints
                .getState()
                .captureSafety({
                  sessionId: sessionId,
                  root: treeRoot,
                  label,
                  access: access,
                })
              return saved.ok
                ? { ok: true, point: saved.entry }
                : saved
            }}
            onRestore={async (sha) => {
              const done = await useCoworkCheckpoints
                .getState()
                .restore(sessionId ?? '', sha)
              // The tree changed underneath every surface that describes
              // it, so the diff is re-read rather than left showing what
              // was there a moment ago.
              if (done.ok) git.refresh()
              return done
            }}
          />
          {/* AH-169: a patch bundle exported elsewhere, reviewed here. */}
          {folder && sessionId ? (
            <CoworkBundleImport
              destination={folder}
              session={sessionId}
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
            .openPath(absolute, pathLinkRoots)
            .catch((e) => toast.error(errorText(e)))
        }}
        // The tree the changes are in, not the one the session is
        // attached to: a managed run's diff lives in its worktree.
        folder={treeRoot}
        git={git}
        origins={origins}
        focusPath={focusPath}
        onClose={onClose}
      />
  )
}
