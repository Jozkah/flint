import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderTree,
  X,
  XCircle,
} from 'lucide-react'
import {
  projectListDir,
  projectReadFile,
  type ProjectEntry,
} from '@janhq/tauri-plugin-agent-tools-api'
import { Button } from '@/components/ui/button'
import { CodeViewer } from '@/components/CodeViewer'
import { CoworkSidePanel } from '@/containers/CoworkSidePanel'
import { getServiceHub, useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { resolveInRoot } from '@/lib/coworkPreview'
import { toast } from 'sonner'
import {
  decideDrop,
  dragHasFiles,
  DROP_ZONE_CLASS,
  dropLabelKey,
  isTypingTarget,
} from '@/lib/fileDrop'
import {
  MAX_CODE_FILE_BYTES,
  closeTab,
  externalTab,
  emptyCodePanelState,
  isSourcePath,
  isTabStale,
  openTab,
  tabBelongsToSession,
  closeOtherTabs,
  closeAllTabs,
  focusTab,
  neighbourTabId,
  activeTab,
  tabId,
  projectKeyOf,
  projectTab,
  toggleDir,
  writeCountsByPath,
  type CodePanelState,
  type CodeRef,
  type CodeTab,
} from '@/lib/coworkCode'
import type { CoworkTurn } from '@/types/coworkSession'
import { readFileAsText } from '@/lib/fileSafety'
import { errorText } from '@/lib/errorText'

type DirState =
  | { status: 'loading' }
  | { status: 'ready'; entries: ProjectEntry[]; truncated: boolean }
  /** The OS refused: a state of its own, not a failure to report raw. */
  | { status: 'denied' }
  | { status: 'error'; message: string }

type FileState =
  | { status: 'loading' }
  /** The project this tab came from is no longer attached. */
  | { status: 'detached' }
  | { status: 'ready'; content: string }
  | { status: 'oversized'; size: number }
  | { status: 'binary' }
  | { status: 'denied' }
  | { status: 'sensitive' }
  /**
   * An external tab whose handle did not survive. Tab metadata persists;
   * the capability to read the file does not.
   */
  | { status: 'external-gone' }
  | { status: 'error'; message: string }

type Props = {
  /** The attached project root; null shows the attach empty state. */
  folder: string | null
  /** The session's writable sandbox, where agent-written artifacts live.
   * Sandbox and artifact tabs read from here instead of the project. `null`
   * while the lookup for the current session is still running. */
  workspacePath: string | null
  /** The session these tabs belong to. Part of the root identity, so a read
   * started for one session can never be applied to another. */
  sessionKey: string | null
  state: CodePanelState | undefined
  /** The session transcript, read only to notice the agent writing an open
   * file. Absent means staleness is never reported, which is correct for a
   * session that has run nothing. */
  turns?: CoworkTurn[]
  onStateChange: (next: CodePanelState) => void
  onAddToChat: (ref: CodeRef) => void
  onAttach: () => void
  onClose: () => void
  /** A folder was dropped; offer to attach it as the project. */
  onOfferFolder?: (name: string) => void
}

/**
 * The Code rail: project explorer, source tabs and the read-only viewer,
 * inside the same CoworkSidePanel chrome as preview and diff.
 *
 * Everything is read through the backend's `project_*` commands, which enforce
 * root containment and refuse sensitive files; this component only renders
 * what it is given.
 */
export function CoworkCodePanel({
  folder,
  workspacePath,
  sessionKey,
  state: stateProp,
  turns,
  onStateChange,
  onAddToChat,
  onAttach,
  onClose,
  onOfferFolder,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const state = stateProp ?? emptyCodePanelState()

  const [dragOver, setDragOver] = useState(false)
  const pickerRef = useRef<HTMLInputElement>(null)
  /**
   * External files, held for this panel's lifetime only.
   *
   * The `File` is kept beside the text so Reload can re-read the same handle
   * the user already granted. It is memory, not storage: nothing about an
   * external file is persisted, so no filesystem access survives a restart,
   * and a handle opened in one session is never visible to another because
   * the map dies with the panel and the tab id carries the session.
   */
  const [externalFiles, setExternalFiles] = useState<
    Record<string, { file: File; content: string }>
  >({})
  /** Latest selection number per external tab; see `openExternalFiles`. */
  const externalReadSeq = useRef(new Map<string, number>())

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
  const writeCounts = useMemo(() => writeCountsByPath(turns), [turns])

  /**
   * Open dropped or picked files as read-only External tabs.
   *
   * Scoped to this session: a file opened here belongs to the session it was
   * opened in and must not surface under the next one. Oversized and
   * unreadable files are reported rather than silently skipped.
   */
  const openExternalFiles = useCallback(
    async (picked: File[]) => {
      if (!sessionKey) return
      // Each opened tab builds on the one before it. The route replaces the
      // whole panel state on every `onStateChange`, so deriving every tab
      // from the pre-loop `state` would keep only the last file of a batch.
      let next = state
      for (const file of picked) {
        // Selections for the same tab are numbered, so a read that resolves
        // late cannot overwrite the bytes of a newer one.
        const target = tabId(externalTab(file.name, sessionKey))
        const seq = (externalReadSeq.current.get(target) ?? 0) + 1
        externalReadSeq.current.set(target, seq)
        if (file.size > MAX_CODE_FILE_BYTES) {
          toast.error(t('common:codePanel.tooLargeToOpen', { name: file.name }))
          continue
        }
        try {
          const read = await readFileAsText(file)
          if (!read.ok) {
            toast.error(
              read.reason === 'sensitive'
                ? t('common:codePanel.sensitiveRefused', { name: file.name })
                : t('common:codePanel.binaryRefused', { name: file.name })
            )
            continue
          }
          if (externalReadSeq.current.get(target) !== seq) continue
          const content = read.text
          const tab = externalTab(file.name, sessionKey)
          setExternalFiles((prev) => ({
            ...prev,
            [tabId(tab)]: { file, content },
          }))
          // An already-open file is focused rather than opened twice.
          next = openTab(next, tab)
          onStateChange(next)
        } catch {
          toast.error(t('common:codePanel.unreadable', { name: file.name }))
        }
      }
    },
    [sessionKey, state, onStateChange, t]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      setDragOver(false)
      const intent = decideDrop('code', Array.from(e.dataTransfer.files))
      if (intent.action === 'open') void openExternalFiles(intent.files)
      else if (intent.action === 'offer-folder') onOfferFolder?.(intent.name)
    },
    [openExternalFiles, onOfferFolder]
  )

  // Cmd+O / Ctrl+O while this panel is mounted, which is while Cowork's code
  // rail is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'o' || !(e.metaKey || e.ctrlKey)) return
      // Not while the user is typing, and not over an open dialog or menu:
      // a global shortcut that interrupts a sentence is a bug.
      if (isTypingTarget(e.target)) return
      if (e.altKey || e.shiftKey) return
      e.preventDefault()
      pickerRef.current?.click()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const [explorerOpen, setExplorerOpen] = useState(
    () => state.tabs.length === 0
  )

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
        const message = messageOf(e)
        setDir(
          gen,
          rel,
          message.startsWith(DENIED_PREFIX)
            ? { status: 'denied' }
            : { status: 'error', message }
        )
      }
    },
    [folder, dataFolder, setDir]
  )

  const loadFile = useCallback(
    async (tab: CodeTab, allowSensitive = false) => {
      const id = tabId(tab)
      const gen = currentGen.current

      // A tab whose project is gone is detached, not loading: say so rather
      // than leaving a spinner nothing will resolve.
      if (
        tab.origin.kind === 'project' &&
        (!folder || tab.origin.projectKey !== projectKey)
      ) {
        setFile(gen, id, { status: 'detached' })
        return
      }
      // A sandbox tab belonging to another session is never read here: its
      // path is relative to that session's directory, so reading it against
      // this one would silently open a different file.
      if (!tabBelongsToSession(tab, sessionKey)) {
        setFile(gen, id, { status: 'detached' })
        return
      }
      // An external file lives outside every root this panel can resolve
      // against, and the handle that made it readable is held in memory only.
      // Reaching here means that handle is gone — a restart, or a tab restored
      // from persisted state — so there is nothing to read. Falling through
      // would resolve its bare name against the session workspace and open a
      // different file that happens to share the name.
      if (tab.origin.kind === 'external') return

      // The roots resolve asynchronously on mount. Record nothing until they
      // are known, so the effect retries once they are — writing a state here
      // would cache a verdict reached before the panel could read anything.
      const rootPending =
        tab.origin.kind === 'project' ? !dataFolder : !workspacePath
      if (rootPending) return

      setFile(gen, id, { status: 'loading' })
      // Snapshot before reading, not after: a write landing during the read
      // would otherwise be counted as already included and the tab would look
      // fresh while showing the older bytes.
      const seen = writeCountsByPath(turnsRef.current)[
        tab.path.replace(/\\/g, '/')
      ]
      setLoadedAt((current) => new Map(current).set(id, seen ?? 0))

      // Sandbox and generated files stream off disk the way the preview pane
      // reads them; the backend project commands only serve the attached
      // project.
      if (tab.origin.kind !== 'project') {
        const abs = workspacePath
          ? resolveInRoot(workspacePath, tab.path)
          : null
        if (!abs) {
          setFile(gen, id, {
            status: 'error',
            message: t('common:preview.outside'),
          })
          return
        }
        try {
          const res = await fetch(getServiceHub().core().convertFileSrc(abs))
          if (!res.ok) throw new Error(String(res.status))
          const size = Number(res.headers.get('content-length') ?? 0)
          if (size > MAX_CODE_FILE_BYTES) {
            setFile(gen, id, { status: 'oversized', size })
            return
          }
          const content = await res.text()
          if (content.length > MAX_CODE_FILE_BYTES) {
            setFile(gen, id, { status: 'oversized', size: content.length })
            return
          }
          setFile(gen, id, { status: 'ready', content })
        } catch (e) {
          setFile(gen, id, { status: 'error', message: messageOf(e) })
        }
        return
      }

      if (!folder || !dataFolder) return
      try {
        const file = await projectReadFile(
          dataFolder,
          folder,
          tab.path,
          allowSensitive
        )
        if (file.oversized) {
          setFile(gen, id, { status: 'oversized', size: file.size })
        } else if (file.binary) {
          setFile(gen, id, { status: 'binary' })
        } else {
          setFile(gen, id, { status: 'ready', content: file.content })
        }
      } catch (e) {
        const message = messageOf(e)
        setFile(
          gen,
          id,
          message.startsWith('SENSITIVE:')
            ? { status: 'sensitive' }
            : message.startsWith(DENIED_PREFIX)
              ? { status: 'denied' }
              : { status: 'error', message }
        )
      }
    },
    [folder, projectKey, sessionKey, workspacePath, dataFolder, setFile, t]
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
    for (const rel of state.expandedDirs) {
      if (!dirs.has(rel)) void loadDir(rel)
    }
  }, [state.expandedDirs, dirs, folder, dataFolder, loadDir])

  // Fetch the active tab's content once per open file.
  const active = activeTab(state)
  const activeId = active ? tabId(active) : null
  useEffect(() => {
    if (!active || !activeId || files.has(activeId)) return
    void loadFile(active)
  }, [active, activeId, files, loadFile])

  // Handles are granted to a session, so they end with it. Keyed ids alone
  // would leave the previous session's bytes reachable from the next one's
  // restored tabs.
  const lastHandleSession = useRef(sessionKey)
  if (lastHandleSession.current !== sessionKey) {
    lastHandleSession.current = sessionKey
    if (Object.keys(externalFiles).length > 0) setExternalFiles({})
  }

  const openPath = useCallback(
    (rel: string) => {
      if (!projectKey) return
      onStateChange(openTab(state, projectTab(rel, projectKey)))
      setExplorerOpen(false)
    },
    [onStateChange, state, projectKey]
  )

  // External files were read into memory when they were opened; there is no
  // path on disk to re-read them from, and they are read-only regardless.
  //
  // The session check is not redundant with the map's keys: a tab stamped to
  // another session can arrive in this session's restored state, and its id
  // would find that session's handle. Without this, one session's bytes
  // render under another.
  const activeFile: FileState | undefined =
    activeId && active && tabBelongsToSession(active, sessionKey)
      && activeId in externalFiles
      ? { status: 'ready', content: externalFiles[activeId].content }
      : // Held in no map on purpose. Whether an external tab still has its
        // handle is known right here, synchronously, and the `files` map is
        // emptied whenever the roots change — which would blink this state
        // out and back as the data folder resolves on mount.
        activeId && active?.origin.kind === 'external'
        ? { status: 'external-gone' }
        : activeId
        ? files.get(activeId)
        : undefined

  /**
   * Offer the file again, because re-reading it is not possible.
   *
   * A `File` from a drop or the picker carries a snapshot of the file as it
   * was when it was handed over. Reading it later cannot return newer bytes:
   * if the file on disk has changed the read fails outright, and if it has
   * not, the bytes are the ones already shown. So there is no "reload" to
   * offer here — only re-selection, which is what this does. The picker's
   * own handler runs the same size and content gates as any other open.
   */
  const chooseExternalAgain = useCallback(() => {
    pickerRef.current?.click()
  }, [])

  const renderTree = (rel: string, depth: number): React.ReactNode => {
    const dir = dirs.get(rel)
    if (!dir || dir.status === 'loading') {
      return (
        <p
          className="px-3 py-1 text-xs text-muted-foreground"
          style={indent(depth)}
        >
          {t('common:codePanel.loading')}
        </p>
      )
    }
    if (dir.status === 'denied') {
      return (
        <p
          className="px-3 py-1 text-xs text-muted-foreground"
          style={indent(depth)}
        >
          {t('common:codePanel.denied')}
        </p>
      )
    }
    if (dir.status === 'error') {
      return (
        <div style={indent(depth)} className="px-3 py-1">
          <p className="text-xs text-destructive">{dir.message}</p>
          <button
            type="button"
            onClick={() => void loadDir(rel)}
            className="mt-1 text-xs text-muted-foreground underline hover:text-foreground"
          >
            {t('common:codePanel.retry')}
          </button>
        </div>
      )
    }
    if (dir.entries.length === 0) {
      return (
        <p
          className="px-3 py-1 text-xs text-muted-foreground"
          style={indent(depth)}
        >
          {t('common:codePanel.emptyDir')}
        </p>
      )
    }
    return (
      <>
        {dir.entries.map((entry) => {
          if (entry.isDir) {
            const expanded = state.expandedDirs.includes(entry.relPath)
            return (
              <div key={entry.relPath}>
                <button
                  type="button"
                  onClick={() => onStateChange(toggleDir(state, entry.relPath))}
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-xs hover:bg-muted/50"
                  style={indent(depth)}
                >
                  {expanded ? (
                    <ChevronDown
                      size={12}
                      className="shrink-0 text-muted-foreground"
                    />
                  ) : (
                    <ChevronRight
                      size={12}
                      className="shrink-0 text-muted-foreground"
                    />
                  )}
                  {expanded ? (
                    <FolderOpen
                      size={13}
                      className="shrink-0 text-muted-foreground"
                    />
                  ) : (
                    <Folder
                      size={13}
                      className="shrink-0 text-muted-foreground"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                </button>
                {expanded && renderTree(entry.relPath, depth + 1)}
              </div>
            )
          }
          const viewable = isSourcePath(entry.relPath)
          return (
            <button
              key={entry.relPath}
              type="button"
              disabled={!viewable}
              onClick={() => openPath(entry.relPath)}
              aria-current={
                state.activeTabId ===
                tabId(projectTab(entry.relPath, projectKey ?? ''))
                  ? true
                  : undefined
              }
              className={cn(
                'flex w-full items-center gap-1 px-2 py-0.5 text-left text-xs',
                viewable ? 'hover:bg-muted/50' : 'opacity-50',
                state.activeTabId ===
                  tabId(projectTab(entry.relPath, projectKey ?? '')) &&
                  'bg-secondary'
              )}
              style={indent(depth)}
            >
              <span className="w-3 shrink-0" />
              <FileIcon size={13} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
          )
        })}
        {dir.truncated && (
          <p
            className="px-3 py-1 text-xs text-muted-foreground"
            style={indent(depth)}
          >
            {t('common:codePanel.truncated')}
          </p>
        )}
      </>
    )
  }

  const body = !folder && state.tabs.length === 0 ? (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <FolderTree size={24} className="text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {t('common:codePanel.noProject')}
      </p>
      <Button size="sm" onClick={onAttach}>
        {t('common:codePanel.attachProject')}
      </Button>
    </div>
  ) : (
    <div className="flex h-full min-h-0 flex-col">
      {/* Tab strip */}
      {state.tabs.length > 0 && (
        <div
          role="tablist"
          aria-label={t('common:codePanel.openFiles')}
          className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1"
        >
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('common:codePanel.explorer')}
            aria-pressed={explorerOpen}
            onClick={() => setExplorerOpen((v) => !v)}
            className={cn(
              'shrink-0',
              explorerOpen ? 'text-brand-text' : 'text-muted-foreground'
            )}
          >
            <FolderTree className="size-3.5" />
          </Button>
          {state.tabs.map((tab) => {
            const id = tabId(tab)
            const name = tab.path.split('/').pop() || tab.path
            const isActive = id === state.activeTabId
            return (
              <div
                key={id}
                role="tab"
                aria-selected={isActive}
                className={cn(
                  'group flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-2 py-0.5 text-xs',
                  isActive
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-muted/50'
                )}
                title={`${tab.path} — ${originTitle(tab, t)}`}
                onClick={() => onStateChange(focusTab(state, id))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onStateChange(focusTab(state, id))
                  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    // Left/right move between tabs, as in a real tablist.
                    e.preventDefault()
                    const next = neighbourTabId(
                      state,
                      e.key === 'ArrowRight' ? 1 : -1
                    )
                    if (next) onStateChange(focusTab(state, next))
                  } else if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault()
                    onStateChange(closeTab(state, id))
                  }
                }}
                tabIndex={isActive ? 0 : -1}
              >
                {tab.origin.kind !== 'project' && (
                  // A sandbox or generated file is not the user's project;
                  // say so rather than letting the name imply it.
                  <span
                    aria-hidden
                    className="shrink-0 text-xs text-muted-foreground"
                  >
                    {tab.origin.kind === 'external' ? 'ext' : 'ws'}
                  </span>
                )}
                <span className="max-w-40 truncate">{name}</span>
                <button
                  type="button"
                  aria-label={t('common:codePanel.closeTab', { name })}
                  onClick={(e) => {
                    e.stopPropagation()
                    onStateChange(closeTab(state, id))
                  }}
                  className="rounded-sm text-muted-foreground hover:text-foreground"
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
          {state.tabs.length > 1 && (
            <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-1">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('common:codePanel.closeOthers')}
                onClick={() =>
                  state.activeTabId &&
                  onStateChange(closeOtherTabs(state, state.activeTabId))
                }
                className="text-muted-foreground"
              >
                <Columns2 className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('common:codePanel.closeAll')}
                onClick={() => onStateChange(closeAllTabs(state))}
                className="text-muted-foreground"
              >
                <XCircle className="size-3.5" />
              </Button>
            </span>
          )}
        </div>
      )}

      {/* Explorer, shown when toggled or when nothing is open. Needs an
          attached folder; sandbox tabs can exist without one. */}
      {folder != null && (explorerOpen || state.tabs.length === 0) && (
        <div
          className={cn(
            'shrink-0 overflow-y-auto border-b py-1',
            state.tabs.length > 0 ? 'max-h-[45%]' : 'flex-1 border-b-0'
          )}
          data-testid="code-explorer"
        >
          {renderTree('', 0)}
        </div>
      )}

      {/* Viewer */}
      {active && activeId && (
        <div className="min-h-0 flex-1">
          {!activeFile || activeFile.status === 'loading' ? (
            <Notice>{t('common:codePanel.loading')}</Notice>
          ) : activeFile.status === 'ready' ? (
            <div className="flex h-full min-h-0 flex-col">
              {/* Announced, not swapped: replacing the bytes under someone
                  mid-read is what the preview pane deliberately avoids. */}
              {/* An external file has no path to watch, so staleness cannot
                  be detected for it — and the handle cannot be re-read for
                  newer bytes either. The honest offer is to choose the file
                  again, which goes through the same gates as a fresh open. */}
              {active.origin.kind === 'external' && (
                <div
                  role="status"
                  className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-ink-2"
                >
                  <span className="min-w-0 flex-1">
                    {t('common:codePanel.externalNote')}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={chooseExternalAgain}
                  >
                    {t('common:codePanel.chooseAgainAction')}
                  </Button>
                </div>
              )}
              {isTabStale(active, loadedAt.get(activeId), writeCounts) && (
                <div
                  role="status"
                  className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-ink-2"
                >
                  <span className="min-w-0 flex-1">
                    {t('common:codePanel.stale')}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={() => void loadFile(active)}
                  >
                    {t('common:codePanel.reload')}
                  </Button>
                </div>
              )}
              <div className="min-h-0 flex-1">
                <CodeViewer
                  relPath={active.path}
                  content={activeFile.content}
                  wordWrap={state.wordWrap}
                  onToggleWrap={(wordWrap) =>
                    onStateChange({ ...state, wordWrap })
                  }
                  origin={active.origin}
                  onAddToChat={onAddToChat}
                />
              </div>
            </div>
          ) : activeFile.status === 'oversized' ? (
            <Notice>
              {t('common:codePanel.tooLarge', {
                size: `${(activeFile.size / (1024 * 1024)).toFixed(1)} MB`,
              })}
            </Notice>
          ) : activeFile.status === 'binary' ? (
            <Notice>{t('common:codePanel.binary')}</Notice>
          ) : activeFile.status === 'denied' ? (
            <Notice>{t('common:codePanel.denied')}</Notice>
          ) : activeFile.status === 'detached' ? (
            // The project went away underneath this tab. Not an error and not
            // a spinner that will never resolve — say what happened and let
            // the tab be closed.
            <Notice>
              <span className="block">{t('common:codePanel.detached')}</span>
              <span className="mt-2 flex justify-center gap-2">
                <Button size="sm" onClick={onAttach}>
                  {t('common:codePanel.attachProject')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onStateChange(closeTab(state, activeId))}
                >
                  {t('common:codePanel.closeMissing')}
                </Button>
              </span>
            </Notice>
          ) : activeFile.status === 'external-gone' ? (
            // Nothing to reload from: say so, and offer the only thing that
            // can actually produce the file again.
            <Notice>
              <span className="block">{t('common:codePanel.externalGone')}</span>
              <span className="mt-2 flex justify-center gap-2">
                <Button size="sm" onClick={chooseExternalAgain}>
                  {t('common:codePanel.chooseAgainAction')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onStateChange(closeTab(state, activeId))}
                >
                  {t('common:codePanel.closeMissing')}
                </Button>
              </span>
            </Notice>
          ) : activeFile.status === 'sensitive' ? (
            <Notice>
              <span className="block">{t('common:codePanel.sensitive')}</span>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => void loadFile(active, true)}
              >
                {t('common:codePanel.openAnyway')}
              </Button>
            </Notice>
          ) : (
            <Notice>
              <span className="block">{activeFile.message}</span>
              <span className="mt-2 flex justify-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void loadFile(active)}
                >
                  {t('common:codePanel.retry')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onStateChange(closeTab(state, activeId))}
                >
                  {t('common:codePanel.closeMissing')}
                </Button>
              </span>
            </Notice>
          )}
        </div>
      )}
    </div>
  )

  return (
    <CoworkSidePanel title={t('common:codePanel.title')} onClose={onClose}>
      <div
        data-testid="code-drop-zone"
        className={cn(
          'relative flex h-full flex-col',
          dragOver && DROP_ZONE_CLASS.code
        )}
        onDragOver={(e) => {
          if (!dragHasFiles(e.dataTransfer)) return
          // Claim the drop here. The document-level handler only stops the
          // browser navigating to the file; it does not stop propagation, so
          // this runs first on the way up.
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setDragOver(false)
        }}
        onDrop={onDrop}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
            <span className="rounded-full border bg-background/95 px-3 py-1 text-xs shadow-sm">
              {t(dropLabelKey('code'))}
            </span>
          </div>
        )}
        <input
          ref={pickerRef}
          type="file"
          multiple
          className="hidden"
          data-testid="code-file-picker"
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? [])
            if (picked.length) void openExternalFiles(picked)
            // Reset, so choosing the same file again still fires a change.
            e.target.value = ''
          }}
        />
        {body}
      </div>
    </CoworkSidePanel>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      <div>{children}</div>
    </div>
  )
}

const indent = (depth: number) => ({ paddingLeft: `${8 + depth * 12}px` })

/** Marker the Rust side puts on an error the OS refused for permissions. */
/** A human phrase for where a tab's file lives, for its tooltip. */
function originTitle(
  tab: CodeTab,
  t: (key: string) => string
): string {
  switch (tab.origin.kind) {
    case 'project':
      return t('common:codePanel.originProject')
    case 'sandbox':
    case 'artifact':
      return t('common:codePanel.originWorkspace')
    case 'external':
      return t('common:codePanel.originExternal')
  }
}

const DENIED_PREFIX = 'DENIED: '

/** Shared so a rejected Tauri command never renders as `[object Object]`. */
const messageOf = errorText
