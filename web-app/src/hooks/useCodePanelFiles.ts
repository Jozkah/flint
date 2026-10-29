import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  projectListDir,
  projectReadFile,
} from '@janhq/tauri-plugin-agent-tools-api'
import { useServiceHub } from '@/hooks/useServiceHub'
import { toAssetUrl } from '@/lib/assetPath'
import { readTextBounded } from '@/lib/boundedRead'
import { resolveInRoot } from '@/lib/coworkPreview'
import { errorText } from '@/lib/errorText'
import {
  projectKeyOf,
  tabBelongsToSession,
  tabId,
  writeCountsByPath,
  type CodeTab,
} from '@/lib/coworkCode'
import {
  boundedReadState,
  dirErrorState,
  projectReadErrorState,
  type DirState,
  type FileState,
} from '@/lib/coworkCodeRead'
import type { CoworkTurn } from '@/types/coworkSession'
import type { UserEdit } from '@/hooks/useCoworkUserEdits'

type Options = {
  /** The attached project root, or null. */
  folder: string | null
  sessionKey: string | null
  /** The session sandbox; null while its lookup is still running. */
  workspacePath: string | null
  /** Where hand edits are saved; a Review only save lives in the sandbox. */
  editDestination: string | undefined
  userEdits: readonly UserEdit[]
  turns: CoworkTurn[] | undefined
  expandedDirs: readonly string[]
  /** The active tab, whose content is fetched once per open file. */
  active: CodeTab | null | undefined
  t: (key: string) => string
}

/**
 * The Code rail's reads: explorer listings and tab contents, each gated on
 * the root identity they were started for.
 */
export function useCodePanelFiles({
  folder,
  sessionKey,
  workspacePath,
  editDestination,
  userEdits,
  turns,
  expandedDirs,
  active,
  t,
}: Options) {
  const serviceHub = useServiceHub()
  const [dataFolder, setDataFolder] = useState<string | null>(null)
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map())
  const [files, setFiles] = useState<Map<string, FileState>>(new Map())
  // Write count per tab at the moment its content was read. A later write to
  // the same path pushes the live count past this one, which is what makes the
  // open copy stale.
  const [loadedAt, setLoadedAt] = useState<Map<string, number>>(new Map())
  // Read through a ref inside `loadFile`: the transcript changes on every
  // streamed token, and depending on it directly would give `loadFile` a new
  // identity each time, re-firing the effect that loads the active tab.
  const turnsRef = useRef(turns)
  turnsRef.current = turns

  /**
   * Which project the panel is currently showing, and a counter that moves
   * whenever that changes.
   *
   * The backend reads are plain promises with no cancellation, so a read
   * started against project A can resolve after A is detached or B attached.
   * Every write below is gated on the generation captured when the read
   * started, which is what stops A's bytes appearing under B's tree.
   */
  const projectKey = useMemo(() => projectKeyOf(folder), [folder])
  /**
   * Every root a read can be issued against. The project is one of them; the
   * session and its workspace are the others, and a change to any of them
   * invalidates work in flight. Keying only on the project let a sandbox read
   * from session A land in session B.
   */
  const rootIdentity = `${projectKey ?? ''}\u0000${sessionKey ?? ''}\u0000${workspacePath ?? ''}`
  const generation = useRef(0)
  /** In-flight sandbox reads by tab id, aborted when superseded or on unmount. */
  const readAborts = useRef(new Map<string, AbortController>())
  useEffect(() => {
    const aborts = readAborts.current
    return () => {
      for (const c of aborts.values()) c.abort()
      aborts.clear()
    }
  }, [rootIdentity])
  const currentGen = useRef(0)
  const lastRootIdentity = useRef<string | undefined>(undefined)
  if (lastRootIdentity.current !== rootIdentity) {
    lastRootIdentity.current = rootIdentity
    generation.current += 1
  }
  currentGen.current = generation.current

  useEffect(() => {
    let alive = true
    void serviceHub
      .app()
      .getJanDataFolder()
      .then((path) => {
        if (alive) setDataFolder(path ?? null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [serviceHub])

  /** Apply a result only if the project it was read for is still attached. */
  const setDir = useCallback((gen: number, rel: string, value: DirState) => {
    if (gen !== currentGen.current) return
    setDirs((current) => new Map(current).set(rel, value))
  }, [])
  const setFile = useCallback((gen: number, id: string, value: FileState) => {
    if (gen !== currentGen.current) return
    setFiles((current) => new Map(current).set(id, value))
  }, [])

  const loadDir = useCallback(
    async (rel: string) => {
      if (!folder || !dataFolder) return
      const gen = currentGen.current
      setDir(gen, rel, { status: 'loading' })
      try {
        const listing = await projectListDir(dataFolder, folder, rel)
        setDir(gen, rel, {
          status: 'ready',
          entries: listing.entries,
          truncated: listing.truncated,
        })
      } catch (e) {
        setDir(gen, rel, dirErrorState(errorText(e)))
      }
    },
    [folder, dataFolder, setDir]
  )

  /**
   * A project file the user saved in Review only lives on as the sandbox
   * copy the save wrote; the tab shows that copy, not the untouched original.
   */
  const sandboxCopyOf = useCallback(
    (tab: CodeTab): string | null => {
      if (tab.origin.kind !== 'project') return null
      if (editDestination !== 'sandbox') return null
      return userEdits.some((e) => e.where === 'sandbox' && e.path === tab.path)
        ? tab.path
        : null
    },
    [editDestination, userEdits]
  )

  /**
   * Read a tab's bytes, or say why not. Null when there is nothing to read
   * yet (roots unresolved) or ever (an external tab without its handle).
   */
  const fetchContent = useCallback(
    async (tab: CodeTab, allowSensitive = false): Promise<FileState | null> => {
      // A tab whose project is gone is detached, not loading: say so rather
      // than leaving a spinner nothing will resolve.
      if (
        tab.origin.kind === 'project' &&
        (!folder || tab.origin.projectKey !== projectKey)
      ) {
        return { status: 'detached' }
      }
      // A sandbox tab belonging to another session is never read here: its
      // path is relative to that session's directory, so reading it against
      // this one would silently open a different file.
      if (!tabBelongsToSession(tab, sessionKey)) return { status: 'detached' }
      // An external file lives outside every root this panel can resolve
      // against, and the handle that made it readable is held in memory only.
      // Reaching here means that handle is gone — a restart, or a tab restored
      // from persisted state — so there is nothing to read. Falling through
      // would resolve its bare name against the session workspace and open a
      // different file that happens to share the name.
      if (tab.origin.kind === 'external') return null

      const copy = sandboxCopyOf(tab)
      // Sandbox and generated files stream off disk the way the preview pane
      // reads them; the backend project commands only serve the attached
      // project.
      if (tab.origin.kind !== 'project' || copy) {
        // The roots resolve asynchronously on mount. Record nothing until
        // they are known, so the effect retries once they are.
        if (!workspacePath) return null
        const abs = resolveInRoot(workspacePath, copy ?? tab.path)
        if (!abs) return { status: 'error', message: t('common:preview.outside') }
        const id = tabId(tab)
        // A newer read of the same tab supersedes this one.
        readAborts.current.get(id)?.abort()
        const controller = new AbortController()
        readAborts.current.set(id, controller)
        const read = await readTextBounded(await toAssetUrl(abs), {
          signal: controller.signal,
        })
        if (readAborts.current.get(id) === controller) {
          readAborts.current.delete(id)
        }
        return boundedReadState(read)
      }

      if (!folder || !dataFolder) return null
      try {
        const file = await projectReadFile(
          dataFolder,
          folder,
          tab.path,
          allowSensitive
        )
        if (file.oversized) {
          return {
            status: 'oversized',
            size: file.size,
            preview: file.preview,
          }
        }
        if (file.binary) return { status: 'binary' }
        return { status: 'ready', content: file.content }
      } catch (e) {
        return projectReadErrorState(errorText(e))
      }
    },
    [folder, projectKey, sessionKey, workspacePath, dataFolder, sandboxCopyOf, t]
  )

  const loadFile = useCallback(
    async (tab: CodeTab, allowSensitive = false) => {
      const id = tabId(tab)
      const gen = currentGen.current
      const rootPending =
        tab.origin.kind === 'project' && !sandboxCopyOf(tab)
          ? !dataFolder
          : !workspacePath
      const quick =
        tab.origin.kind === 'project' &&
        (!folder || tab.origin.projectKey !== projectKey)
      if (!quick && tabBelongsToSession(tab, sessionKey)) {
        if (tab.origin.kind === 'external' || rootPending) return
        setFile(gen, id, { status: 'loading' })
        // Snapshot before reading, not after: a write landing during the read
        // would otherwise be counted as already included and the tab would
        // look fresh while showing the older bytes.
        const seen = writeCountsByPath(turnsRef.current)[
          tab.path.replace(/\\/g, '/')
        ]
        setLoadedAt((current) => new Map(current).set(id, seen ?? 0))
      }
      const result = await fetchContent(tab, allowSensitive)
      if (result) setFile(gen, id, result)
    },
    [
      folder,
      projectKey,
      sessionKey,
      workspacePath,
      dataFolder,
      setFile,
      fetchContent,
      sandboxCopyOf,
    ]
  )

  // Root listing, and re-listing whenever a root identity changes. Everything
  // cached belonged to the previous roots, including the staleness snapshots.
  useEffect(() => {
    setDirs(new Map())
    setFiles(new Map())
    setLoadedAt(new Map())
    if (folder && dataFolder) void loadDir('')
  }, [rootIdentity, folder, dataFolder, loadDir])

  // Lazily fetch expanded directories that have no cached listing yet
  // (including ones restored from a persisted session).
  useEffect(() => {
    if (!folder || !dataFolder) return
    for (const rel of expandedDirs) {
      if (!dirs.has(rel)) void loadDir(rel)
    }
  }, [expandedDirs, dirs, folder, dataFolder, loadDir])

  // Fetch the active tab's content once per open file.
  const activeId = active ? tabId(active) : null
  useEffect(() => {
    if (!active || !activeId || files.has(activeId)) return
    void loadFile(active)
  }, [active, activeId, files, loadFile])

  return {
    projectKey,
    dataFolder,
    dirs,
    files,
    loadedAt,
    loadDir,
    loadFile,
    fetchContent,
    sandboxCopyOf,
  }
}
