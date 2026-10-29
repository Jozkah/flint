import { isPlatformTauri } from '@/lib/platform/utils'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { toast } from 'sonner'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { janAuthoredChanges } from '@/lib/coworkChangeSummary'
import { authorizeDirectEdit as runAuthorizeDirectEdit } from '@/lib/coworkDirectEdit'
import { authorityMayChange, useCoworkActiveWork } from '@/hooks/useCoworkActiveWork'
import { type DirectEditFacts } from '@/containers/dialogs/DirectEditConfirmDialog'
import { useShowPromptSnapshot } from '@/hooks/useCoworkDisplay'
import { applySandboxFile, planSandboxApply } from '@/lib/coworkSandboxApply'
import { probeSandboxFile } from '@/lib/coworkApplyAll'
import type { SandboxApplyActions } from '@/containers/CoworkApplyAllDialog'
import { accessOf, type AccessMode } from '@/lib/coworkAccess'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { DEFAULT_SESSION_TITLE } from '@/lib/coworkSessionStart'
import { sandboxEnforces } from '@/lib/agentTools'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { CoworkGitState } from '@/hooks/useCoworkGitStatus'
import type { Dispatch } from 'react'
import type { SetStateAction } from 'react'
import type { EffectiveAccess } from '@/lib/coworkAccess'
import type { ServiceHub } from '@/services'
import type { RefObject } from 'react'
import type { LiveGrant } from '@/lib/coworkAccess'
import type { CapabilityState } from '@/hooks/useDirectEditGrants'
import type { CoworkMode } from '@/lib/coworkMode'
import type { CoworkFileDiff } from '@/lib/coworkDiffs'

export type CoworkEditAuthorityArgs = {
  session: CoworkSession | null
  git: CoworkGitState
  folder: string | null
  workspacePath: string | null
  applyFolders: string[]
  setPendingAccess: Dispatch<SetStateAction<Record<string, AccessMode>>>
  setConfirmDirectEdit: Dispatch<SetStateAction<boolean>>
  effective: EffectiveAccess
  serviceHub: ServiceHub
  writableExtraFolders: string[]
  bindingRef: RefObject<{ sessionId: string | null; folder: string | null; }>
  access: AccessMode
  liveGrant: LiveGrant | undefined
  capabilityState: CapabilityState
  mainFolderReadOnly: boolean
  t: (key: string, options?: Record<string, unknown>) => string
  gitBranch: string | null
  mode: CoworkMode
  fileDiffs: CoworkFileDiff[]
}

export function useCoworkEditAuthority({
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
}: CoworkEditAuthorityArgs) {
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
    bindingRef,
    setConfirmDirectEdit,
    setPendingAccess,
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
    bindingRef,
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
  return {
    authorizeManagedWorktree,
    authorizeDirectEdit,
    returnToReviewOnly,
    changeCounts,
    showPromptSnapshot,
    sandboxApply,
    directEditFacts,
  }
}
