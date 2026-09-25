/**
 * The `@` menu: files and folders in the attached folder, skills, saved agents
 * and aliases, in one ranked list. AH-204.
 *
 * Focus stays in the composer while the menu is open; the composer moves the
 * active option with the arrow keys and points `aria-activedescendant` at it,
 * so the menu is usable by keyboard alone and a screen reader follows the
 * active row. The one control that takes focus is the alias-name field, and
 * closing it hands focus back to the composer.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  Bot,
  Bookmark,
  Folder,
  File,
  FileCode,
  FileText,
  ImageIcon,
  FileJson,
  FileType,
  Sparkles,
} from 'lucide-react'
import {
  optionId,
  type ReferenceEntry,
  type ReferenceKind,
} from '@/lib/referenceMenu'

// ─── File-type icon helper ───────────────────────────────────────────────────
const extIconMap: Record<string, typeof FileCode> = {
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  rs: FileCode,
  py: FileCode,
  go: FileCode,
  java: FileCode,
  cpp: FileCode,
  c: FileCode,
  h: FileCode,
  json: FileJson,
  yaml: FileJson,
  yml: FileJson,
  toml: FileJson,
  md: FileText,
  txt: FileText,
  pdf: FileText,
  png: ImageIcon,
  jpg: ImageIcon,
  jpeg: ImageIcon,
  gif: ImageIcon,
  svg: ImageIcon,
  css: FileType,
  scss: FileType,
  html: FileType,
  xml: FileType,
}

const KIND_LABEL: Record<ReferenceKind, string> = {
  file: 'file',
  directory: 'folder',
  skill: 'skill',
  agent: 'agent',
  alias: 'alias',
}

function EntryIcon({ entry }: { entry: ReferenceEntry }) {
  if (entry.kind === 'directory')
    return <Folder aria-hidden className="size-4 shrink-0 text-amber-500" />
  if (entry.kind === 'skill')
    return <Sparkles aria-hidden className="size-4 shrink-0 text-violet-500" />
  if (entry.kind === 'agent')
    return <Bot aria-hidden className="size-4 shrink-0 text-emerald-600" />
  if (entry.kind === 'alias')
    return <Bookmark aria-hidden className="size-4 shrink-0 text-sky-600" />
  const Icon = extIconMap[entry.extension?.toLowerCase() ?? '']
  if (Icon)
    return <Icon aria-hidden className="size-4 shrink-0 text-blue-500" />
  return <File aria-hidden className="size-4 shrink-0 text-muted-foreground" />
}

type FilePickerPopoverProps = {
  entries: ReferenceEntry[]
  /** The text after `@`. */
  query: string
  open: boolean
  position: { top: number; left: number } | null
  /** Owned by the composer, which moves it with the arrow keys. */
  activeIndex: number
  onActiveChange: (index: number) => void
  onSelect: (entry: ReferenceEntry) => void
  onClose: () => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  listId: string
  /** The file or folder being named as an alias, while the name is typed. */
  aliasDraft: ReferenceEntry | null
  aliasError?: string | null
  /** `lines` is empty for the whole file, or `12` / `12-20` for a selection. */
  onAliasSave: (name: string, lines: string) => void
  onAliasCancel: () => void
}

export function FilePickerPopover({
  entries,
  query,
  open,
  position,
  activeIndex,
  onActiveChange,
  onSelect,
  onClose,
  textareaRef,
  listId,
  aliasDraft,
  aliasError,
  onAliasSave,
  onAliasCancel,
}: FilePickerPopoverProps) {
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const [aliasName, setAliasName] = useState('')
  const [aliasLines, setAliasLines] = useState('')

  useEffect(() => {
    setAliasName('')
    setAliasLines('')
  }, [aliasDraft])

  const popoverStyle = useMemo(() => {
    if (!position || !textareaRef.current) {
      return { top: 0, left: 0, opacity: 0 as const }
    }
    return { top: position.top, left: position.left }
  }, [position, textareaRef])

  useEffect(() => {
    itemRefs.current.get(activeIndex)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  if (!open || (entries.length === 0 && !aliasDraft)) return null

  return (
    <div
      className="absolute z-50 w-[400px] max-h-[300px] overflow-y-auto rounded-lg border border-border bg-popover shadow-popover p-1"
      style={popoverStyle}
      data-testid="reference-menu"
    >
      <div className="px-2 py-1.5 text-xs text-muted-foreground border-b border-border/50 mb-1">
        {entries.length === 1 ? '1 result' : `${entries.length} results`}
        {query && (
          <span>
            {' '}
            for{' '}
            <span className="font-mono font-medium text-fg-2">
              @{query}
            </span>
          </span>
        )}
        <span className="block text-[10px] opacity-60">
          ↑↓ choose · Enter/Tab insert · Alt+A name a file as an alias · Esc
          close
        </span>
      </div>
      {aliasDraft && (
        <form
          className="mb-1 flex flex-col gap-1 rounded-lg bg-accent/40 px-2 py-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            onAliasSave(aliasName, aliasLines)
          }}
          data-testid="alias-form"
        >
          <label
            htmlFor={`${listId}-alias`}
            className="text-xs text-muted-foreground"
          >
            Alias for {aliasDraft.token}
          </label>
          <input
            id={`${listId}-alias`}
            autoFocus
            value={aliasName}
            onChange={(e) => setAliasName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                onAliasCancel()
              }
            }}
            className="rounded border border-border bg-background px-2 py-1 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="alias-name"
          />
          {aliasDraft.kind === 'file' && (
            <>
              <label
                htmlFor={`${listId}-alias-lines`}
                className="text-xs text-muted-foreground"
              >
                Lines (optional, e.g. 12-20)
              </label>
              <input
                id={`${listId}-alias-lines`}
                value={aliasLines}
                inputMode="numeric"
                onChange={(e) => setAliasLines(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    onAliasCancel()
                  }
                }}
                className="rounded border border-border bg-background px-2 py-1 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="alias-lines"
              />
              {/* Enter in either field saves. */}
              <button type="submit" className="sr-only">
                Save alias
              </button>
            </>
          )}
          {aliasError && (
            <p role="alert" className="text-xs text-destructive">
              {aliasError}
            </p>
          )}
        </form>
      )}
      <div id={listId} role="listbox" aria-label="References">
        {entries.map((entry, idx) => (
          <div
            key={`${entry.kind}:${entry.token}`}
            id={optionId(listId, idx)}
            ref={(el) => {
              if (el) itemRefs.current.set(idx, el)
              else itemRefs.current.delete(idx)
            }}
            className={cn(
              'flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-sm transition-colors',
              idx === activeIndex
                ? 'bg-primary/10 text-primary-foreground ring-1 ring-primary/40'
                : 'hover:bg-accent'
            )}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(entry)}
            onMouseEnter={() => onActiveChange(idx)}
            role="option"
            aria-selected={idx === activeIndex}
            data-kind={entry.kind}
            data-token={entry.token}
          >
            <EntryIcon entry={entry} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-medium truncate">{entry.name}</span>
                <span className="text-xs text-muted-foreground uppercase shrink-0">
                  {entry.kind === 'file'
                    ? (entry.extension ?? KIND_LABEL.file)
                    : KIND_LABEL[entry.kind]}
                </span>
              </div>
              {entry.detail && (
                <div className="text-[11px] text-muted-foreground truncate">
                  {entry.detail}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {/* Esc is handled by the composer; this closes it for a pointer user. */}
      <button type="button" className="sr-only" onClick={onClose}>
        Close references
      </button>
    </div>
  )
}
