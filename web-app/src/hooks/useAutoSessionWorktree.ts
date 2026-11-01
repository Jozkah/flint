import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { resumeSessionWorktree } from '@/lib/worktreeResume'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCoworkParallel } from '@/hooks/useCoworkParallel'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import { sharedFolder, type IsolationReason } from '@/lib/sharedFolder'
import {
  autoIsolateAction,
  copyApi,
  copyAsWorktree,
  isGitRepo,
  isPlaceholderTitle,
} from '@/lib/coworkParallel'

type Input = {
  sessionId: string | null
  title: string | undefined
  folder: string | null
  /** The extra folders the grant should cover (the ones left editable). */
  extraFolders: readonly string[]
  access: string
  turns: number
  capabilityKnown: boolean
  managedWorktreeCapable: boolean
  busy: boolean
  /** Where the user is right now, read after every await. */
  currentBinding: () => { sessionId: string | null; folder: string | null }
}

/**
 * Put a new session in its own worktree when the user enables that setting,
 * so many sessions can work in one repository at once.
 *
 * A new session (no turns yet, still on the default access mode) attached to a
 * Git folder gets a managed worktree and branch -- `flint/<title>-<id>` -- and
 * a grant for it, exactly as choosing "Managed worktree" by hand would. The
 * branch is renamed once the session has a real title. Any session still set
 * to Managed worktree re-attaches its own checkout after a restart. A plain folder
 * is not copied automatically; the bar offers "Work on a copy" instead.
 *
 * Returns whether the folder is a Git repository (null while unknown) and the
 * action that starts a copy.
 */
export function useAutoSessionWorktree(input: Input) {
  const serviceHub = useServiceHub()
  const { t } = useTranslation()
  const tRef = useRef(t)
  tRef.current = t
  const enabled = useCoworkParallel((s) => s.autoWorktree)
  const mark = useCoworkParallel((s) =>
    input.sessionId && input.folder
      ? s.auto[`${input.sessionId}\u0000${input.folder}`]
      : undefined
  )
  const copyPath = useCoworkParallel((s) =>
    input.sessionId ? s.copies[input.sessionId] : undefined
  )
  const record = useCoworkWorktrees((s) =>
    input.sessionId ? s.bySession[input.sessionId] : undefined
  )
  const [isGit, setIsGit] = useState<boolean | null>(null)
  const inFlight = useRef<string | null>(null)
  const inputRef = useRef(input)
  inputRef.current = input
  const isFork = useCoworkSessions(
    (s) => !!s.sessions.find((x) => x.id === input.sessionId)?.forkedFrom
  )

  // Shared-folder default: a fork, or a second session in a Git folder that
  // already has a live one, starts in its own worktree whatever the setting
  // says. Asked of the backend registry, which knows who is live. A failure
  // leaves the default off (the session then shares the tree, claims apply).
  const [sharedIsolate, setSharedIsolate] = useState(false)
  // Why it is isolated (for the line that says so), and whether the person
  // chose the shared tree instead (per session; the answer then stays "shared").
  const [sharedReason, setSharedReason] = useState<IsolationReason | null>(null)
  const [choseShared, setChoseShared] = useState<string | null>(null)
  const userChoseShared = choseShared !== null && choseShared === input.sessionId
  useEffect(() => {
    setSharedIsolate(false)
    setSharedReason(null)
    if (!input.sessionId || !input.folder || input.turns > 0 || isGit !== true)
      return
    let cancelled = false
    void sharedFolder
      .defaultIsolation({
        folder: input.folder,
        sessionId: input.sessionId,
        isFork,
        userChoseShared,
      })
      .then((d) => {
        if (cancelled) return
        setSharedIsolate(d.isolate)
        setSharedReason(d.isolate ? d.reason : null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [input.sessionId, input.folder, input.turns, isGit, isFork, userChoseShared])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setIsGit(null)
    const folder = input.folder
    if (!folder) return
    // null = the check failed, not "not a repo": stay unknown and retry a
    // couple of times, so a busy backend is not remembered as a negative.
    const check = (retriesLeft: number) => {
      void isGitRepo(folder).then((yes) => {
        if (cancelled) return
        if (yes === null && retriesLeft > 0) {
          timer = setTimeout(() => check(retriesLeft - 1), 3000)
          return
        }
        setIsGit(yes)
      })
    }
    check(2)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [input.folder])

  /** Grant `path` and switch the session to it. */
  const attach = useCallback(
    async (sid: string, folder: string, path: string, dataFolder: string) => {
      const now = inputRef.current.currentBinding()
      if (now.sessionId !== sid || now.folder !== folder) return false
      const granted = await useDirectEditGrants
        .getState()
        .authorize(sid, path, dataFolder, inputRef.current.extraFolders)
      if (!granted.ok) {
        if (granted.reason !== 'superseded') toast.error(granted.reason)
        return false
      }
      useCoworkSessions.getState().setAccess(sid, 'managed-worktree')
      return true
    },
    []
  )

  const action = autoIsolateAction({
    enabled: enabled || sharedIsolate,
    sessionId: input.sessionId,
    folder: input.folder,
    access: input.access,
    hasWorktree: !!record,
    capable: input.managedWorktreeCapable,
    capabilityKnown: input.capabilityKnown,
    turns: input.turns,
    mark,
    busy: input.busy,
  })

  useEffect(() => {
    const sid = input.sessionId
    const folder = input.folder
    if (action === 'none' || !sid || !folder) return
    // A copy session resumes its copy; everything else needs Git.
    if (mark !== 'copy' && isGit === null) return
    const key = `${sid}\u0000${folder}`
    if (inFlight.current === key) return
    inFlight.current = key
    void (async () => {
      try {
        const dataFolder = await serviceHub
          .app()
          .getJanDataFolder()
          .catch(() => '')
        if (!dataFolder) return
        const parallel = useCoworkParallel.getState()
        if (mark === 'copy') {
          if (!copyPath) return
          const copy = await copyApi.create(dataFolder, sid, folder).catch(() => null)
          if (!copy) return
          useCoworkWorktrees.getState().adopt(sid, copyAsWorktree(copy))
          await attach(sid, folder, copy.path, dataFolder)
          return
        }
        // Only a real `false` gets here: an unknown (null) answer returned
        // early above, so a failed check never marks the session skipped.
        if (!isGit) {
          if (action === 'start') parallel.mark(sid, folder, 'skipped')
          return
        }
        const title = inputRef.current.title
        // A reopened session only finds its own checkout: when that is gone
        // it goes back to review only and says so, never into a new one.
        const made =
          action === 'resume'
            ? await resumeSessionWorktree(sid, folder, dataFolder)
            : await useCoworkWorktrees.getState().ensure(sid, folder, dataFolder, {
                title: isPlaceholderTitle(title) ? undefined : title,
              })
        if (!made.ok) {
          // The default is a convenience: when it cannot apply, the session
          // stays where it was, and says why only when it had been isolated.
          if (action === 'start') parallel.mark(sid, folder, 'skipped')
          else if (action === 'resume')
            toast.error(tRef.current('common:coworkParallel.resumeGone', { reason: made.reason }))
          else toast.error(made.reason)
          return
        }
        if (await attach(sid, folder, made.record.path, dataFolder))
          parallel.mark(sid, folder, 'worktree')
        else useCoworkWorktrees.getState().forget(sid)
      } finally {
        inFlight.current = null
      }
    })()
  }, [action, input.sessionId, input.folder, isGit, mark, copyPath, serviceHub, attach])

  // Name the branch after the session once it has a title.
  useEffect(() => {
    const sid = input.sessionId
    if (!sid || !record || record.kind === 'copy') return
    if (isPlaceholderTitle(input.title)) return
    if (!/^(flint\/session-|jan\/cowork\/)/.test(record.branch)) return
    if (mark !== 'worktree') return
    void (async () => {
      const dataFolder = await serviceHub
        .app()
        .getJanDataFolder()
        .catch(() => '')
      if (dataFolder)
        await useCoworkWorktrees.getState().rename(sid, dataFolder, input.title!)
    })()
  }, [input.sessionId, input.title, record, mark, serviceHub])

  const workOnCopy = useCallback(async () => {
    const { sessionId: sid, folder } = inputRef.current
    if (!sid || !folder) return
    const dataFolder = await serviceHub
      .app()
      .getJanDataFolder()
      .catch(() => '')
    if (!dataFolder) return
    let copy
    try {
      copy = await copyApi.create(dataFolder, sid, folder)
    } catch (e) {
      toast.error(String(e))
      return
    }
    useCoworkWorktrees.getState().adopt(sid, copyAsWorktree(copy))
    if (await attach(sid, folder, copy.path, dataFolder)) {
      useCoworkParallel.getState().mark(sid, folder, 'copy')
      useCoworkParallel.getState().setCopy(sid, copy.path)
    } else useCoworkWorktrees.getState().forget(sid)
  }, [serviceHub, attach])

  /**
   * "Use the shared folder instead": drops the worktree the default made (the
   * session has no turns, so nothing is lost) and keeps the session on the
   * shared tree, where claims and the git guard stay in force.
   */
  const chooseShared = useCallback(async () => {
    const { sessionId: sid, folder } = inputRef.current
    if (!sid || !folder) return
    setChoseShared(sid)
    setSharedIsolate(false)
    const parallel = useCoworkParallel.getState()
    if (useCoworkWorktrees.getState().bySession[sid]) {
      const dataFolder = await serviceHub
        .app()
        .getJanDataFolder()
        .catch(() => '')
      const done = dataFolder
        ? await useCoworkWorktrees.getState().discard(sid, dataFolder, false)
        : { ok: false as const, reason: '' }
      if (!done.ok) {
        if (done.reason) toast.error(done.reason)
        setChoseShared(null)
        return
      }
      void useDirectEditGrants.getState().revokeSession(sid)
      useCoworkSessions.getState().setAccess(sid, 'review-only')
    }
    parallel.mark(sid, folder, 'skipped')
  }, [serviceHub])

  return {
    isGit,
    workOnCopy,
    /**
     * Why the default put this session in its own worktree, while it applies.
     * Only once the worktree exists and the session is switched to it: the
     * decision alone said "using its own worktree" while a worktree that could
     * not be made (or was never attached) left writes landing in the checkout.
     */
    isolationReason:
      (sharedReason === 'fork' || sharedReason === 'secondSession') &&
      record &&
      record.kind !== 'copy' &&
      input.access === 'managed-worktree'
        ? sharedReason
        : null,
    /** The person chose the shared tree for this session. */
    choseShared: userChoseShared,
    chooseShared,
  }
}
