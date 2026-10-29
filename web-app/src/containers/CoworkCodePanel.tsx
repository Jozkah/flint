import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { FolderTree } from 'lucide-react'
import { projectReadFile } from '@janhq/tauri-plugin-agent-tools-api'
import { toast } from 'sonner'
import { toAssetUrl } from '@/lib/assetPath'
import { Button } from '@/components/ui/button'
import { CodeViewer } from '@/components/CodeViewer'
import { CoworkSidePanel } from '@/containers/CoworkSidePanel'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { resolveInRoot } from '@/lib/coworkPreview'
import {
  decideDrop,
  dragHasFiles,
  DROP_ZONE_CLASS,
  dropLabelKey,
  isTypingTarget,
  dropFilePaths,
} from '@/lib/fileDrop'
import { baseName, readDroppedPaths } from '@/lib/droppedPaths'
import { isPlatformTauri } from '@/lib/platform/utils'
import {
  MAX_CODE_FILE_BYTES,
  closeTab,
  externalTab,
  emptyCodePanelState,
  isTabStale,
  openTab,
  tabBelongsToSession,
  activeTab,
  tabId,
  projectTab,
  sandboxTab,
  toggleDir,
  writeCountsByPath,
  detectLanguage,
  type CodePanelState,
  type CodeRef,
} from '@/lib/coworkCode'
import type { CoworkTurn } from '@/types/coworkSession'
import { readFileAsText } from '@/lib/fileSafety'
import { readTextBounded } from '@/lib/boundedRead'
import { errorText } from '@/lib/errorText'
import { detectEol, toLf, withEol } from '@/lib/lineEndings'
import { isExecutablePath, toOsPath } from '@/lib/pathOpen'
import { changedLines, collectCodeFileDiffs } from '@/lib/coworkDiffs'
import { useTheme } from '@/hooks/useTheme'
import {
  dropBuffer,
  isDirty,
  planUserWrite,
  type Buffers,
  type EditAccess,
  type EditTarget,
} from '@/lib/coworkCodeEdit'
import { saveUserEdit, type SaveUserEdit } from '@/lib/coworkCodeSave'
import type { FileState } from '@/lib/coworkCodeRead'
import {
  NO_BUFFERS,
  NO_USER_EDITS,
  useCodeBuffers,
  useCoworkUserEdits,
} from '@/hooks/useCoworkUserEdits'
import { useCodePanelFiles } from '@/hooks/useCodePanelFiles'
import { useCodePanelSave } from '@/hooks/useCodePanelSave'
import { BlameCard, HunkPopover } from '@/containers/CodeGitOverlays'
import {
  useBlameHover,
  useBlameLabel,
  useCodeGitOverlays,
} from '@/hooks/useCodeGitOverlays'
import {
  applySandboxHunk,
  revertHunk,
  sandboxHunks,
  type ChangeHunk,
} from '@/lib/codeGutter'
import { CodeFileTree } from '@/containers/codePanel/CodeFileTree'
import { CodeTabStrip } from '@/containers/codePanel/CodeTabStrip'
import {
  CodeFileNotice,
  Notice,
} from '@/containers/codePanel/CodeFileNotice'
import {
  ConflictBanner,
  ExternalFileBanner,
  SaveErrorBanner,
  StaleFileBanner,
  UnsavedCloseBanner,
} from '@/containers/codePanel/CodePanelBanners'
import { CodeEditToolbar } from '@/containers/codePanel/CodeEditToolbar'
import {
  SandboxPeekPopover,
  type PeekNote,
} from '@/containers/codePanel/SandboxPeekPopover'

// The editor and its grammars load on first edit, not with the app.
const CodeEditor = lazy(() => import('@/components/CodeEditor'))

type Props = {
  /** The attached project root; null shows the attach empty state. */
  folder: string | null
  /** The project's name beside the panel title. */
  projectName?: string
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
  /**
   * Where hand edits may be saved: the session's write destination and live
   * grant. Absent keeps every tab read-only, as before editing existed.
   */
  editAccess?: EditAccess | null
  /** The folder the session reads, passed to the write the way a run's is. */
  readRoot?: string | null
  /** The session's other attached folders, likewise. */
  extraFolders?: readonly string[]
  /** Performs a save. Injected by tests; the real one is the `write` tool. */
  saveFile?: SaveUserEdit
  /** A save landed, so views of the tree (Changes) can re-read it. */
  onSaved?: () => void
  /**
   * The session sandbox copy a Review only run made of this project file
   * (its path in the sandbox), mapped the way Apply to folder maps it. Its
   * changes show as markers on the real file.
   */
  sandboxCopyFor?: (projectPath: string) => string | null
  /** Copy the whole sandbox file over the project file (after confirming). */
  onApplySandboxCopy?: (projectPath: string) => void
  /**
   * Write `content` (the real file with one sandbox change applied) over the
   * project file while it still holds `expected`.
   */
  onApplySandboxHunk?: (
    projectPath: string,
    expected: string,
    content: string
  ) => Promise<'applied' | 'changed'>
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
  projectName,
  workspacePath,
  sessionKey,
  state: stateProp,
  turns,
  onStateChange,
  onAddToChat,
  onAttach,
  onClose,
  onOfferFolder,
  editAccess,
  readRoot,
  extraFolders,
  saveFile = saveUserEdit,
  onSaved,
  sandboxCopyFor,
  onApplySandboxCopy,
  onApplySandboxHunk,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const state = stateProp ?? emptyCodePanelState()
  const isDark = useTheme((s) => s.isDark)

  const buffers = useCodeBuffers((s) =>
    sessionKey ? (s.bySession[sessionKey] ?? NO_BUFFERS) : NO_BUFFERS
  )
  const setBuffers = useCallback(
    (next: (current: Buffers) => Buffers) => {
      if (sessionKey) useCodeBuffers.getState().update(sessionKey, next)
    },
    [sessionKey]
  )
  const userEdits = useCoworkUserEdits((s) =>
    sessionKey ? (s.bySession[sessionKey]?.edits ?? NO_USER_EDITS) : NO_USER_EDITS
  )
  const [selection, setSelection] = useState<CodeRef | null>(null)

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
      setDragOver(false)
      const route = (files: File[]) => {
        const intent = decideDrop('code', files)
        if (intent.action === 'open') void openExternalFiles(intent.files)
        else if (intent.action === 'offer-folder') onOfferFolder?.(intent.name)
      }
      if (e.dataTransfer.files.length > 0) {
        e.preventDefault()
        e.stopPropagation()
        route(Array.from(e.dataTransfer.files))
        return
      }
      // WebKitGTK: a file-manager drop may arrive as URIs only. A dragged
      // link or text is not claimed. Only GNOME's own drag type is trusted: a
      // web page can name any local path in the text a dragged link carries.
      const named = isPlatformTauri() ? dropFilePaths(e.dataTransfer) : null
      const paths = named?.trusted ? named.paths : null
      if (!paths) return
      e.preventDefault()
      e.stopPropagation()
      void readDroppedPaths(paths).then(({ files, folders, failed }) => {
        if (folders.length > 0) onOfferFolder?.(baseName(folders[0]))
        if (files.length > 0) route(files)
        for (const folder of folders.slice(1)) {
          toast.error(t('common:codePanel.oneFolderAtATime', { name: baseName(folder) }))
        }
        for (const f of failed) {
          toast.error(t('common:codePanel.unreadable', { name: baseName(f.path) }))
        }
      })
    },
    [openExternalFiles, onOfferFolder, t]
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

  const active = activeTab(state)
  const activeId = active ? tabId(active) : null
  const {
    projectKey,
    dataFolder,
    dirs,
    files,
    loadedAt,
    loadDir,
    loadFile,
    fetchContent,
    sandboxCopyOf,
  } = useCodePanelFiles({
    folder,
    sessionKey,
    workspacePath,
    editDestination: editAccess?.destination,
    userEdits,
    turns,
    expandedDirs: state.expandedDirs,
    active,
    t,
  })

  const fileChanges = useMemo(() => {
    if (!active || active.origin.kind === 'external') return undefined
    const root = active.origin.kind === 'project' ? folder : workspacePath
    if (!root) return undefined
    const selected = resolveInRoot(root, active.path)?.toLowerCase()
    if (!selected) return undefined
    const diff = collectCodeFileDiffs(turns ?? [], []).find(
      (file) => resolveInRoot(root, file.path)?.toLowerCase() === selected
    )
    return diff ? changedLines(diff) : undefined
  }, [active, folder, workspacePath, turns])

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

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  /** Where saving the active tab writes, or why it cannot. */
  const editTarget: EditTarget | null = active
    ? planUserWrite({
        tab: active,
        projectKey,
        treeRoot: folder,
        sessionKey,
        access: editAccess,
      })
    : null
  const writable =
    editTarget && editTarget.kind !== 'read-only' ? editTarget : null
  const editable =
    !!editAccess &&
    !!writable &&
    activeFile?.status === 'ready' &&
    !(activeId && activeId in externalFiles)
  const activeBuffer = activeId ? buffers[activeId] : undefined
  const activeDirty = isDirty(activeBuffer)
  const readyContent =
    activeFile?.status === 'ready' ? toLf(activeFile.content) : undefined
  // How the file on disk ends its lines, put back when the buffer is saved.
  const diskEol = detectEol(
    activeFile?.status === 'ready' ? activeFile.content : ''
  )

  /** Re-read the active file and compare it with what the editor started from. */
  const recheckDisk = useCallback(async (): Promise<string | null> => {
    if (!active || !activeId) return null
    const read = await fetchContent(active)
    return read?.status === 'ready' ? toLf(read.content) : null
  }, [active, activeId, fetchContent])

  const {
    conflict,
    pendingClose,
    saving,
    saveError,
    save,
    discard,
    requestClose,
    confirmClose,
    resolveConflict,
  } = useCodePanelSave({
    active,
    activeId,
    sessionKey,
    editTarget,
    editable,
    readyContent,
    diskEol,
    buffers,
    setBuffers,
    recheckDisk,
    saveFile,
    readRoot,
    extraFolders,
    onSaved,
    onStateChange,
    t,
  })

  // ---- Git overlays: change markers against HEAD, and inline blame. ----
  const gitTab = editable && active?.origin.kind === 'project' ? active : null
  const copyOfProject = gitTab ? sandboxCopyOf(gitTab) : null
  // A Review only sandbox copy is compared with the project file it copies.
  const [original, setOriginal] = useState<string | null>(null)
  useEffect(() => {
    setOriginal(null)
    if (!copyOfProject || !folder || !dataFolder) return
    let alive = true
    void projectReadFile(dataFolder, folder, copyOfProject, false)
      .then((file) => {
        if (alive && !file.binary && !file.oversized) {
          setOriginal(toLf(file.content))
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [copyOfProject, folder, dataFolder])
  const overlays = useCodeGitOverlays({
    root: gitTab ? folder : null,
    path: gitTab?.path ?? null,
    text: activeBuffer?.text ?? null,
    disk: activeBuffer?.base ?? null,
    original: copyOfProject ? original : undefined,
    savedCount: userEdits.length,
  })
  // A Review only run's own copy of this file: its changes as markers on the
  // real one, a peek away, instead of changes against HEAD.
  const agentCopy =
    gitTab && !copyOfProject ? (sandboxCopyFor?.(gitTab.path) ?? null) : null
  const [agentCopyText, setAgentCopyText] = useState<string | null>(null)
  useEffect(() => {
    setAgentCopyText(null)
    if (!agentCopy || !workspacePath) return
    const abs = resolveInRoot(workspacePath, agentCopy)
    if (!abs) return
    let alive = true
    const controller = new AbortController()
    void toAssetUrl(abs)
      .then((url) => readTextBounded(url, { signal: controller.signal }))
      .then((read) => {
      if (alive) setAgentCopyText(read.status === 'ready' ? toLf(read.content) : null)
    })
    return () => {
      alive = false
      controller.abort()
    }
  }, [agentCopy, workspacePath])
  const agentHunks = useMemo(
    () =>
      agentCopyText !== null && activeBuffer?.text !== undefined
        ? sandboxHunks(activeBuffer.text, agentCopyText)
        : null,
    [agentCopyText, activeBuffer?.text]
  )
  const editorHunks = agentHunks ?? overlays.hunks
  const openAgentCopy = () => {
    if (agentCopy && sessionKey) {
      onStateChange(openTab(state, sandboxTab(agentCopy, sessionKey)))
    }
  }
  const blameLabel = useBlameLabel()
  const blameForEditor = useMemo(
    () =>
      overlays.blameLines && !copyOfProject
        ? { lines: overlays.blameLines, label: blameLabel }
        : null,
    [overlays.blameLines, copyOfProject, blameLabel]
  )
  const blameHover = useBlameHover()
  const [openHunk, setOpenHunk] = useState<ChangeHunk | null>(null)
  const showsAgentHunks = agentHunks !== null
  useEffect(() => setOpenHunk(null), [activeId, showsAgentHunks])
  /** What the sandbox peek says under its header, if anything. */
  const [peekNote, setPeekNote] = useState<PeekNote>(null)
  useEffect(() => setPeekNote(null), [openHunk])
  /**
   * Apply the peeked change alone: re-read the real file, re-apply the change
   * to what is there now, and write only if the lines it replaces are
   * unchanged -- checked here and again by the backend at the write.
   */
  const applyPeekedHunk = async () => {
    const hunk = openHunk
    if (!hunk || !active || !onApplySandboxHunk || !folder || !dataFolder) return
    if (activeDirty) {
      setPeekNote('dirty')
      return
    }
    try {
      const fresh = await projectReadFile(dataFolder, folder, active.path, false)
      // Hunks are computed on the editor's LF text; the file keeps its own
      // line endings, so apply on LF and write back in the file's style.
      const next = applySandboxHunk(toLf(fresh.content), hunk)
      if (next === null) {
        setPeekNote('conflict')
        return
      }
      const outcome = await onApplySandboxHunk(
        active.path,
        fresh.content,
        withEol(next, detectEol(fresh.content))
      )
      if (outcome === 'changed') {
        setPeekNote('conflict')
        return
      }
      if (activeId) setBuffers((current) => dropBuffer(current, activeId))
      await loadFile(active)
      setOpenHunk(null)
    } catch (e) {
      setPeekNote({ error: errorText(e) })
    }
  }
  // The element a peeked change renders into, inline in the editor.
  const peekDom = useMemo(() => document.createElement('div'), [])
  const peek = useMemo(
    () => (openHunk ? { hunk: openHunk, dom: peekDom } : null),
    [openHunk, peekDom]
  )
  // The same marker again closes its peek.
  const toggleHunk = useCallback(
    (hunk: ChangeHunk) =>
      setOpenHunk((current) =>
        current && current.start === hunk.start && current.kind === hunk.kind
          ? null
          : hunk
      ),
    []
  )
  const revertOpenHunk = () => {
    if (!openHunk || !activeId) return
    const hunk = openHunk
    setBuffers((current) => {
      const buffer = current[activeId]
      if (!buffer) return current
      return {
        ...current,
        [activeId]: { base: buffer.base, text: revertHunk(buffer.text, hunk) },
      }
    })
    setOpenHunk(null)
  }

  /**
   * Open the active file in the OS, through the same contained command the
   * path links use: the Rust side re-checks the root and refuses to run an
   * executable (those are only revealed).
   */
  const openActiveExternally = useCallback(() => {
    if (!active) return
    const root = active.origin.kind === 'project' ? folder : workspacePath
    const abs = root ? resolveInRoot(root, active.path) : null
    if (!root || !abs) return
    void getServiceHub()
      .core()
      .invoke('open_session_path', {
        roots: [root],
        path: toOsPath(abs),
        mode: isExecutablePath(abs) ? 'reveal' : 'open',
      })
      .catch((e: unknown) => toast.error(errorText(e)))
  }, [active, folder, workspacePath])

  const closeActive = () => {
    if (activeId) onStateChange(closeTab(state, activeId))
  }
  const reveal =
    state.reveal && state.reveal.tabId === activeId ? state.reveal : null

  const editorPane =
    active && activeId && activeFile?.status === 'ready' && editable && writable ? (
      <div className="flex h-full min-h-0 min-w-0 flex-col">
        <CodeEditToolbar
          path={active.path}
          savesToSandbox={
            writable.kind === 'sandbox' && active.origin.kind === 'project'
          }
          dirty={activeDirty}
          saving={saving}
          wordWrap={state.wordWrap}
          onToggleWrap={() =>
            onStateChange({ ...state, wordWrap: !state.wordWrap })
          }
          showAgentCopy={!!agentCopy}
          onOpenAgentCopy={openAgentCopy}
          onDiscard={discard}
          onSave={() => void save()}
        />
        <div className="relative min-h-0 flex-1 border-t border-dashed border-border bg-code-bg">
          <Suspense fallback={<Notice>{t('common:codePanel.loading')}</Notice>}>
            <CodeEditor
              docKey={activeId}
              value={activeBuffer?.text ?? toLf(activeFile.content)}
              lang={detectLanguage(active.path).lang}
              wordWrap={state.wordWrap}
              isDark={isDark}
              ariaLabel={active.path}
              onChange={(text) =>
                setBuffers((current) => ({
                  ...current,
                  [activeId]: {
                    base: current[activeId]?.base ?? toLf(activeFile.content),
                    text,
                  },
                }))
              }
              onSave={() => void save()}
              onSelection={(span) =>
                setSelection(
                  span
                    ? { ...span, path: active.path, origin: active.origin }
                    : null
                )
              }
              reveal={reveal}
              hunks={editorHunks}
              blame={blameForEditor}
              onHunk={toggleHunk}
              onBlameHover={blameHover.onBlameHover}
              peek={peek}
              onPeekClose={() => setOpenHunk(null)}
            />
          </Suspense>
          {openHunk &&
            createPortal(
              agentHunks ? (
                <SandboxPeekPopover
                  hunk={openHunk}
                  path={active.path}
                  note={peekNote}
                  onApplyHunk={
                    onApplySandboxHunk ? () => void applyPeekedHunk() : undefined
                  }
                  onOpenCopy={openAgentCopy}
                  onApplyWhole={
                    onApplySandboxCopy
                      ? () => onApplySandboxCopy(active.path)
                      : undefined
                  }
                  onNote={setPeekNote}
                  onClose={() => setOpenHunk(null)}
                />
              ) : (
                <HunkPopover
                  hunk={openHunk}
                  onRevert={revertOpenHunk}
                  onClose={() => setOpenHunk(null)}
                />
              ),
              peekDom
            )}
          {blameHover.hover && folder && (
            <BlameCard
              commit={blameHover.hover.commit}
              anchor={blameHover.hover.anchor}
              root={folder}
              webUrl={overlays.webUrl}
              onEnter={blameHover.keep}
              onLeave={blameHover.leave}
            />
          )}
          {selection && selection.path === active.path && (
            <div className="absolute bottom-2 left-2 z-10 inline-flex">
              <Button
                size="sm"
                variant="surface"
                className="shadow-pop"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onAddToChat(selection)
                  setSelection(null)
                }}
              >
                {t('common:codePanel.addToChat', {
                  range:
                    selection.startLine === selection.endLine
                      ? `L${selection.startLine}`
                      : `L${selection.startLine}-${selection.endLine}`,
                })}
              </Button>
            </div>
          )}
        </div>
      </div>
    ) : null

  const viewer =
    active && activeId ? (
      activeFile?.status === 'ready' ? (
        <div className="flex h-full min-h-0 flex-col">
          {active.origin.kind === 'external' && (
            <ExternalFileBanner onChooseAgain={chooseExternalAgain} />
          )}
          {isTabStale(active, loadedAt.get(activeId), writeCounts) && (
            <StaleFileBanner onReload={() => void loadFile(active)} />
          )}
          {conflict && conflict.id === activeId && (
            <ConflictBanner onResolve={(c) => void resolveConflict(c)} />
          )}
          {saveError && editable && <SaveErrorBanner error={saveError} />}
          <div className="min-h-0 flex-1">
            {editorPane ?? (
              <CodeViewer
                relPath={active.path}
                content={activeFile.content}
                wordWrap={state.wordWrap}
                onToggleWrap={(wordWrap) => onStateChange({ ...state, wordWrap })}
                origin={active.origin}
                changedLines={fileChanges}
                onAddToChat={onAddToChat}
                readOnlyHint={
                  editAccess && editTarget?.kind === 'read-only'
                    ? t(`common:codePanel.readOnlyReason.${editTarget.reason}`)
                    : undefined
                }
                revealLine={reveal}
              />
            )}
          </div>
        </div>
      ) : (
        <CodeFileNotice
          file={activeFile}
          path={active.path}
          onReload={(allowSensitive) => void loadFile(active, allowSensitive)}
          onCloseTab={closeActive}
          onAttach={onAttach}
          onChooseAgain={chooseExternalAgain}
          onOpenExternally={openActiveExternally}
        />
      )
    ) : null

  const body = !folder && state.tabs.length === 0 ? (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center motion-safe:animate-rise-in">
      <span className="grid size-10 place-items-center rounded-xl bg-card text-muted-foreground shadow-lift">
        <FolderTree size={18} />
      </span>
      <p className="max-w-xs text-xs text-muted-foreground">
        {t('common:codePanel.noProject')}
      </p>
      <Button size="sm" onClick={onAttach}>
        {t('common:codePanel.attachProject')}
      </Button>
    </div>
  ) : (
    <div className="flex h-full min-h-0 flex-col">
      {state.tabs.length > 0 && (
        <CodeTabStrip
          state={state}
          buffers={buffers}
          explorerOpen={explorerOpen}
          onToggleExplorer={() => setExplorerOpen((v) => !v)}
          onStateChange={onStateChange}
          requestClose={requestClose}
        />
      )}

      {pendingClose && (
        <UnsavedCloseBanner
          count={pendingClose.ids.length}
          name={
            state.tabs.find((tab) => tabId(tab) === pendingClose.ids[0])?.path ??
            pendingClose.ids[0]
          }
          canSave={
            pendingClose.ids.length === 1 &&
            pendingClose.ids[0] === activeId &&
            editable
          }
          onChoose={(choice) => void confirmClose(choice)}
        />
      )}

      {/* Explorer, shown when toggled or when nothing is open. Needs an
          attached folder; sandbox tabs can exist without one. */}
      {folder != null && (explorerOpen || state.tabs.length === 0) && (
        <div
          className={cn(
            'shrink-0 overflow-y-auto border-b border-dashed border-border py-1.5 [scrollbar-width:thin]',
            state.tabs.length > 0 ? 'max-h-[45%]' : 'flex-1 border-b-0'
          )}
          data-testid="code-explorer"
        >
          <CodeFileTree
            rel=""
            depth={0}
            dirs={dirs}
            expandedDirs={state.expandedDirs}
            activeTabId={state.activeTabId}
            projectKey={projectKey}
            onToggleDir={(rel) => onStateChange(toggleDir(state, rel))}
            onOpenFile={openPath}
            onRetry={(rel) => void loadDir(rel)}
          />
        </div>
      )}

      {/* Viewer */}
      {viewer && <div className="min-h-0 flex-1">{viewer}</div>}
    </div>
  )

  return (
    <CoworkSidePanel
      title={t('common:codePanel.title')}
      summary={
        projectName ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {projectName}
          </span>
        ) : undefined
      }
      onClose={onClose}
    >
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
            <span className="rounded-full bg-popover px-3 py-1 text-xs shadow-pop motion-safe:animate-dd-in">
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
