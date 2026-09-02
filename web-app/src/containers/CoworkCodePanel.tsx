import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderTree,
  X,
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
import {
  MAX_CODE_FILE_BYTES,
  closeTab,
  emptyCodePanelState,
  isSandboxTabPath,
  isSourcePath,
  isTabStale,
  openTab,
  tabDisplayPath,
  toggleDir,
  writeCountsByPath,
  type CodePanelState,
  type CodeRef,
} from '@/lib/coworkCode'
import type { CoworkTurn } from '@/types/coworkSession'

type DirState =
  | { status: 'loading' }
  | { status: 'ready'; entries: ProjectEntry[]; truncated: boolean }
  /** The OS refused: a state of its own, not a failure to report raw. */
  | { status: 'denied' }
  | { status: 'error'; message: string }

type FileState =
  | { status: 'loading' }
  | { status: 'ready'; content: string }
  | { status: 'oversized'; size: number }
  | { status: 'binary' }
  | { status: 'denied' }
  | { status: 'sensitive' }
  | { status: 'error'; message: string }

type Props = {
  /** The attached project root; null shows the attach empty state. */
  folder: string | null
  /** The session's writable sandbox, where agent-written artifacts live.
   * `sandbox:`-prefixed tabs read from here instead of the project. */
  workspacePath: string | null
  state: CodePanelState | undefined
  /** The session transcript, read only to notice the agent writing an open
   * file. Absent means staleness is never reported, which is correct for a
   * session that has run nothing. */
  turns?: CoworkTurn[]
  onStateChange: (next: CodePanelState) => void
  onAddToChat: (ref: CodeRef) => void
  onAttach: () => void
  onClose: () => void
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
  state: stateProp,
  turns,
  onStateChange,
  onAddToChat,
  onAttach,
  onClose,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const state = stateProp ?? emptyCodePanelState()

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
  const [explorerOpen, setExplorerOpen] = useState(
    () => state.openPaths.length === 0
  )

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

  const setDir = useCallback((rel: string, value: DirState) => {
    setDirs((current) => new Map(current).set(rel, value))
  }, [])
  const setFile = useCallback((rel: string, value: FileState) => {
    setFiles((current) => new Map(current).set(rel, value))
  }, [])

  const loadDir = useCallback(
    async (rel: string) => {
      if (!folder || !dataFolder) return
      setDir(rel, { status: 'loading' })
      try {
        const listing = await projectListDir(dataFolder, folder, rel)
        setDir(rel, {
          status: 'ready',
          entries: listing.entries,
          truncated: listing.truncated,
        })
      } catch (e) {
        const message = messageOf(e)
        setDir(
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
    async (tabPath: string, allowSensitive = false) => {
      setFile(tabPath, { status: 'loading' })
      // Snapshot before reading, not after: a write landing during the read
      // would otherwise be counted as already included and the tab would look
      // fresh while showing the older bytes.
      const seen = writeCountsByPath(turnsRef.current)[
        tabDisplayPath(tabPath).replace(/\\/g, '/')
      ]
      setLoadedAt((current) => new Map(current).set(tabPath, seen ?? 0))
      // Sandbox artifacts stream off disk the same way the preview pane reads
      // them; the backend project commands only serve the attached project.
      if (isSandboxTabPath(tabPath)) {
        const rel = tabDisplayPath(tabPath)
        const abs = workspacePath ? resolveInRoot(workspacePath, rel) : null
        if (!abs) {
          setFile(tabPath, {
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
            setFile(tabPath, { status: 'oversized', size })
            return
          }
          const content = await res.text()
          if (content.length > MAX_CODE_FILE_BYTES) {
            setFile(tabPath, { status: 'oversized', size: content.length })
            return
          }
          setFile(tabPath, { status: 'ready', content })
        } catch (e) {
          setFile(tabPath, { status: 'error', message: messageOf(e) })
        }
        return
      }
      if (!folder || !dataFolder) return
      try {
        const file = await projectReadFile(
          dataFolder,
          folder,
          tabPath,
          allowSensitive
        )
        if (file.oversized) {
          setFile(tabPath, { status: 'oversized', size: file.size })
        } else if (file.binary) {
          setFile(tabPath, { status: 'binary' })
        } else {
          setFile(tabPath, { status: 'ready', content: file.content })
        }
      } catch (e) {
        const message = messageOf(e)
        setFile(
          tabPath,
          message.startsWith('SENSITIVE:')
            ? { status: 'sensitive' }
            : message.startsWith(DENIED_PREFIX)
              ? { status: 'denied' }
              : { status: 'error', message }
        )
      }
    },
    [folder, workspacePath, dataFolder, setFile, t]
  )

  // Root listing, and re-listing when the attached folder changes.
  useEffect(() => {
    setDirs(new Map())
    setFiles(new Map())
    if (folder && dataFolder) void loadDir('')
  }, [folder, dataFolder, loadDir])

  // Lazily fetch expanded directories that have no cached listing yet
  // (including ones restored from a persisted session).
  useEffect(() => {
    if (!folder || !dataFolder) return
    for (const rel of state.expandedDirs) {
      if (!dirs.has(rel)) void loadDir(rel)
    }
  }, [state.expandedDirs, dirs, folder, dataFolder, loadDir])

  // Fetch the active tab's content once per open file.
  const activePath = state.activePath
  useEffect(() => {
    if (!activePath || files.has(activePath)) return
    void loadFile(activePath)
  }, [activePath, files, loadFile])

  const openPath = useCallback(
    (rel: string) => {
      onStateChange(openTab(state, rel))
      setExplorerOpen(false)
    },
    [onStateChange, state]
  )

  const activeFile = activePath ? files.get(activePath) : undefined

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
                      className="shrink-0 text-main-view-fg/50"
                    />
                  ) : (
                    <ChevronRight
                      size={12}
                      className="shrink-0 text-main-view-fg/50"
                    />
                  )}
                  {expanded ? (
                    <FolderOpen
                      size={13}
                      className="shrink-0 text-main-view-fg/60"
                    />
                  ) : (
                    <Folder
                      size={13}
                      className="shrink-0 text-main-view-fg/60"
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
              aria-current={state.activePath === entry.relPath || undefined}
              className={cn(
                'flex w-full items-center gap-1 px-2 py-0.5 text-left text-xs',
                viewable ? 'hover:bg-muted/50' : 'opacity-50',
                state.activePath === entry.relPath && 'bg-secondary'
              )}
              style={indent(depth)}
            >
              <span className="w-3 shrink-0" />
              <FileIcon size={13} className="shrink-0 text-main-view-fg/50" />
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

  const body = !folder && state.openPaths.length === 0 ? (
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
      {state.openPaths.length > 0 && (
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
              explorerOpen ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            <FolderTree className="size-3.5" />
          </Button>
          {state.openPaths.map((path) => {
            const name = tabDisplayPath(path).split('/').pop() ?? path
            const active = path === state.activePath
            return (
              <div
                key={path}
                role="tab"
                aria-selected={active}
                className={cn(
                  'group flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-2 py-0.5 text-xs',
                  active
                    ? 'bg-secondary text-main-view-fg'
                    : 'text-main-view-fg/60 hover:bg-muted/50'
                )}
                title={path}
                onClick={() => openPath(path)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') openPath(path)
                }}
                tabIndex={0}
              >
                <span className="max-w-40 truncate">{name}</span>
                <button
                  type="button"
                  aria-label={t('common:codePanel.closeTab', { name })}
                  onClick={(e) => {
                    e.stopPropagation()
                    onStateChange(closeTab(state, path))
                  }}
                  className="rounded-sm text-main-view-fg/40 hover:text-main-view-fg"
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Explorer, shown when toggled or when nothing is open. Needs an
          attached folder; sandbox tabs can exist without one. */}
      {folder != null && (explorerOpen || state.openPaths.length === 0) && (
        <div
          className={cn(
            'shrink-0 overflow-y-auto border-b py-1',
            state.openPaths.length > 0 ? 'max-h-[45%]' : 'flex-1 border-b-0'
          )}
          data-testid="code-explorer"
        >
          {renderTree('', 0)}
        </div>
      )}

      {/* Viewer */}
      {activePath && (
        <div className="min-h-0 flex-1">
          {!activeFile || activeFile.status === 'loading' ? (
            <Notice>{t('common:codePanel.loading')}</Notice>
          ) : activeFile.status === 'ready' ? (
            <div className="flex h-full min-h-0 flex-col">
              {/* Announced, not swapped: replacing the bytes under someone
                  mid-read is what the preview pane deliberately avoids. */}
              {isTabStale(activePath, loadedAt.get(activePath), writeCounts) && (
                <div
                  role="status"
                  className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-main-view-fg/70"
                >
                  <span className="min-w-0 flex-1">
                    {t('common:codePanel.stale')}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={() => void loadFile(activePath)}
                  >
                    {t('common:codePanel.reload')}
                  </Button>
                </div>
              )}
              <div className="min-h-0 flex-1">
                <CodeViewer
                  relPath={tabDisplayPath(activePath)}
                  content={activeFile.content}
                  wordWrap={state.wordWrap}
                  onToggleWrap={(wordWrap) =>
                    onStateChange({ ...state, wordWrap })
                  }
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
          ) : activeFile.status === 'sensitive' ? (
            <Notice>
              <span className="block">{t('common:codePanel.sensitive')}</span>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => void loadFile(activePath, true)}
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
                  onClick={() => void loadFile(activePath)}
                >
                  {t('common:codePanel.retry')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onStateChange(closeTab(state, activePath))}
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
      {body}
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
const DENIED_PREFIX = 'DENIED: '

const messageOf = (e: unknown): string =>
  e && typeof e === 'object' && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e)
