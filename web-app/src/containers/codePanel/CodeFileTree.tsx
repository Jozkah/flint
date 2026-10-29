import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
} from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { isSourcePath, projectTab, tabId } from '@/lib/coworkCode'
import type { DirState } from '@/lib/coworkCodeRead'

type Props = {
  /** The folder to render, relative to the project root ('' is the root). */
  rel: string
  depth: number
  dirs: ReadonlyMap<string, DirState>
  expandedDirs: readonly string[]
  activeTabId: string | null | undefined
  projectKey: string | null
  onToggleDir: (rel: string) => void
  onOpenFile: (rel: string) => void
  onRetry: (rel: string) => void
}

const ROW_CLASS =
  'flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[length:calc(var(--ui-font-base)*0.78125)] text-fg-2 outline-none transition-colors hover:bg-hover-row focus-visible:bg-hover-row'

const indent = (depth: number) => ({ paddingLeft: `${10 + depth * 14}px` })
/** Where a folder's guide line sits: under its own chevron. */
const guide = (depth: number) =>
  ({ '--guide': `${16 + depth * 14}px` }) as React.CSSProperties

/** The Code rail's project explorer: one folder's listing, recursively. */
export function CodeFileTree(props: Props): React.ReactElement {
  const {
    rel,
    depth,
    dirs,
    expandedDirs,
    activeTabId,
    projectKey,
    onToggleDir,
    onOpenFile,
    onRetry,
  } = props
  const { t } = useTranslation()
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
          onClick={() => onRetry(rel)}
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
          const expanded = expandedDirs.includes(entry.relPath)
          return (
            <div key={entry.relPath}>
              <button
                type="button"
                onClick={() => onToggleDir(entry.relPath)}
                aria-expanded={expanded}
                className={ROW_CLASS}
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
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                ) : (
                  <Folder size={14} className="shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
              {/* A guide line down the open folder's children, as the
                  design's file trees draw them. */}
              {expanded && (
                <div
                  className="relative motion-safe:animate-tree-in before:pointer-events-none before:absolute before:inset-y-0 before:left-[var(--guide)] before:w-px before:bg-border"
                  style={guide(depth)}
                >
                  <CodeFileTree
                    {...props}
                    rel={entry.relPath}
                    depth={depth + 1}
                  />
                </div>
              )}
            </div>
          )
        }
        const viewable = isSourcePath(entry.relPath)
        const isActive =
          activeTabId === tabId(projectTab(entry.relPath, projectKey ?? ''))
        return (
          <button
            key={entry.relPath}
            type="button"
            onClick={() => onOpenFile(entry.relPath)}
            aria-current={isActive ? true : undefined}
            className={cn(
              ROW_CLASS,
              !viewable && 'text-muted-foreground',
              isActive && 'bg-accent font-medium text-foreground'
            )}
            style={indent(depth)}
          >
            <span className="w-3 shrink-0" />
            <FileIcon size={14} className="shrink-0 text-muted-foreground" />
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
