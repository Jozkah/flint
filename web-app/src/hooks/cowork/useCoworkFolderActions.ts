import { isPlatformTauri } from '@/lib/platform/utils'
import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { useCoworkSessions, ensureCurrentSession } from '@/hooks/useCoworkSessions'
import { authorityMayChange, useCoworkActiveWork } from '@/hooks/useCoworkActiveWork'
import { usePrompt } from '@/hooks/usePrompt'
import { codeRefToken, type CodeRef } from '@/lib/coworkCode'
import {
  extraFoldersOf,
  mainFolderReadOnlyOf,
  sameFolder,
  writableExtraFoldersOf,
} from '@/lib/coworkFolders'
import { accessOf, type AccessMode } from '@/lib/coworkAccess'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import { isSessionEmpty } from '@/lib/coworkSessionStart'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import {
  isRemoteSession,
  modeToAccess,
  startRemoteSession,
} from '@/lib/remoteCowork'
import { isServerTransport } from '@/lib/serverTransportFlag'
import { pickServerFolder } from '@/lib/serverFolderPicker'
import type { RefObject } from 'react'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { ServiceHub } from '@/services'
import type { Dispatch } from 'react'
import type { SetStateAction } from 'react'

export type CoworkFolderActionsArgs = {
  pendingRefs: RefObject<CodeRef[]>
  session: CoworkSession | null
  folder: string | null
  t: (key: string, options?: Record<string, unknown>) => string
  serviceHub: ServiceHub
  paneSessionIdRef: RefObject<string | undefined>
  setPendingFolder: Dispatch<SetStateAction<Record<string, string>>>
  setPendingAccess: Dispatch<SetStateAction<Record<string, AccessMode>>>
}

export function useCoworkFolderActions({
  pendingRefs,
  session,
  folder,
  t,
  serviceHub,
  paneSessionIdRef,
  setPendingFolder,
  setPendingAccess,
}: CoworkFolderActionsArgs) {
  // Cleared when the session changes *or* when the attached project does: a
  // reference carries the bytes and the path of the project it was taken
  // from, and sending it after a switch would label another project's source
  // as this one's.
  useEffect(() => {
    pendingRefs.current = []
  }, [session?.id, folder, pendingRefs])

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
  }, [pendingRefs])

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
  }, [serviceHub, session?.id, t, paneSessionIdRef, setPendingAccess, setPendingFolder])

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
  return {
    attachFolder,
    detachFolder,
    setFolderWritable,
    addExtraFolder,
    removeExtraFolder,
    addCodeToChat,
  }
}
