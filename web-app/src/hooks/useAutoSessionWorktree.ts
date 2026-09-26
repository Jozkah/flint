import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { useCoworkParallel } from '@/hooks/useCoworkParallel'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
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
 * Put a new session in its own worktree, by default, so many sessions can work
 * in one repository at once.
 *
 * A new session (no turns yet, still on the default access mode) attached to a
 * Git folder gets a managed worktree and branch -- `flint/<title>-<id>` -- and
 * a grant for it, exactly as choosing "Managed worktree" by hand would. The
 * branch is renamed once the session has a real title. A session the default
 * isolated earlier re-attaches its own worktree after a restart. A plain folder
 * is not copied automatically; the bar offers "Work on a copy" instead.
 *
 * Returns whether the folder is a Git repository (null while unknown) and the
 * action that starts a copy.
 */
export function useAutoSessionWorktree(input: Input) {
  const serviceHub = useServiceHub()
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

  useEffect(() => {
    let cancelled = false
    setIsGit(null)
    if (!input.folder) return
    void isGitRepo(input.folder).then((yes) => {
      if (!cancelled) setIsGit(yes)
    })
    return () => {
      cancelled = true
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
    enabled,
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
        if (!isGit) {
          if (action === 'start') parallel.mark(sid, folder, 'skipped')
          return
        }
        const title = inputRef.current.title
        const made = await useCoworkWorktrees.getState().ensure(sid, folder, dataFolder, {
          title: isPlaceholderTitle(title) ? undefined : title,
        })
        if (!made.ok) {
          // The default is a convenience: when it cannot apply, the session
          // stays where it was, and says why only when it had been isolated.
          if (action === 'start') parallel.mark(sid, folder, 'skipped')
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

  return { isGit, workOnCopy }
}
