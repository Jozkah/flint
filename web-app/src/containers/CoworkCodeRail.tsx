import { useTranslation } from '@/i18n/react-i18next-compat'
import type { SandboxApplyActions } from '@/containers/CoworkApplyAllDialog'
import { CoworkCodePanel } from '@/containers/CoworkCodePanel'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { basenameOf } from '@/lib/coworkPreview'
import { applySandboxHunk, sandboxCopyOfProjectFile } from '@/lib/coworkSandboxApply'
import { errorText } from '@/lib/errorText'
import { toast } from 'sonner'
import type { ComponentProps } from 'react'

type PanelProps = ComponentProps<typeof CoworkCodePanel>

type Props = {
  sessionId: string
  codePanel: PanelProps['state']
  turns: PanelProps['turns']
  folder: string | null
  treeRoot: PanelProps['folder']
  workspacePath: PanelProps['workspacePath']
  extraFolders: PanelProps['extraFolders']
  /** Where hand edits save, and the grant they save under. */
  destination: NonNullable<PanelProps['editAccess']>['destination']
  relativeIsProject: boolean
  writeGrant: string | undefined
  sandboxApply: SandboxApplyActions | undefined
  fileDiffs: { path: string }[]
  git: { refresh: () => void }
  onAttachFolder: () => void
  onAddToChat: PanelProps['onAddToChat']
  onClose: () => void
}

/** The Code rail: the run's tree with edits, sandbox copies and apply actions. */
export function CoworkCodeRail({
  sessionId,
  codePanel,
  turns,
  folder,
  treeRoot,
  workspacePath,
  extraFolders,
  destination,
  relativeIsProject,
  writeGrant,
  sandboxApply,
  fileDiffs,
  git,
  onAttachFolder,
  onAddToChat,
  onClose,
}: Props) {
  const { t } = useTranslation()
  return (
      <CoworkCodePanel
        onOfferFolder={onAttachFolder}
        // The tree the run reads. Browsing the attached folder while the
        // agent works in a worktree would show two different repositories
        // under one name.
        folder={treeRoot}
        projectName={folder ? basenameOf(folder) : undefined}
        workspacePath={workspacePath}
        sessionKey={sessionId}
        state={codePanel}
        turns={turns}
        onStateChange={(next) =>
          useCoworkSessions.getState().setCodePanel(sessionId, next)
        }
        onAddToChat={onAddToChat}
        onAttach={onAttachFolder}
        onClose={onClose}
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
        onApplySandboxHunk={
          !sandboxApply
            ? undefined
            : async (projectPath, expected, content) => {
          const copy =
            sandboxApply && sessionId
              ? sandboxCopyOfProjectFile(
                  fileDiffs.map((f) => f.path),
                  sandboxApply.planFor,
                  folder,
                  projectPath
                )
              : null
          if (!copy || !sessionId) throw new Error(`${projectPath} has no sandbox copy`)
          const outcome = await applySandboxHunk({
            session: sessionId,
            path: copy.plan.source,
            project: copy.plan.folder,
            destination: copy.plan.destination,
            expected,
            content,
          })
          if (outcome === 'applied') git.refresh()
          return outcome
              }
        }
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
          destination: destination,
          writeGrant: relativeIsProject
            ? (writeGrant ?? null)
            : null,
        }}
        readRoot={treeRoot}
        extraFolders={extraFolders}
        onSaved={() => git.refresh()}
      />
  )
}
