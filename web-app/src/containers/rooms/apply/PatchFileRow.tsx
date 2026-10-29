import { AlertTriangle, ChevronDown, XCircle } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import type { PatchFile, PatchFileStatus } from '@/lib/rooms/applyReview'
import { ApplyChip } from './ApplyChip'
import { FileDiff } from './FileDiff'

type T = (key: string, options?: Record<string, unknown>) => string

const STATUS_TONE: Record<PatchFileStatus, string> = {
  added: 'bg-success-tint text-success',
  modified: 'bg-muted text-muted-foreground',
  deleted: 'bg-destructive-tint text-destructive',
  renamed: 'bg-warning-tint text-warning',
}

type Props = {
  file: PatchFile
  /** Included in the apply. */
  selected: boolean
  expanded: boolean
  /** The dry run says this file does not apply. */
  conflict: boolean
  /** The user has uncommitted edits in it. */
  dirty: boolean
  onToggleSelected: () => void
  onToggleExpanded: () => void
  t: T
}

/** One file of the patch: include box, path, badges, and its diff when open. */
export function PatchFileRow({
  file: f,
  selected: on,
  expanded: isOpen,
  conflict: bad,
  dirty: mine,
  onToggleSelected,
  onToggleExpanded,
  t,
}: Props): React.ReactElement {
  const slash = f.path.lastIndexOf('/')
  return (
    <li
      data-testid="apply-file"
      className={cn(
        'min-w-0 overflow-hidden rounded-lg border-[0.8px] border-border bg-card transition-opacity',
        !on && 'opacity-55'
      )}
    >
      <div className="flex min-h-10 items-center gap-2.5 px-3 py-2">
        <Checkbox
          className="size-3.5 shrink-0"
          checked={on}
          onChange={onToggleSelected}
          aria-label={t('rooms:apply.include', { path: f.path })}
        />
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={onToggleExpanded}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
        >
          <ChevronDown
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              !isOpen && '-rotate-90'
            )}
          />
          <span
            className="min-w-0 truncate font-mono text-xs"
            title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
          >
            {slash > 0 && <span className="text-muted-foreground">{f.path.slice(0, slash + 1)}</span>}
            <span className="font-medium text-foreground">{f.path.slice(slash + 1)}</span>
            {f.oldPath && (
              <span className="text-muted-foreground"> {t('rooms:apply.renamedFrom', { path: f.oldPath })}</span>
            )}
          </span>
        </button>
        {bad && (
          <ApplyChip className="border-destructive/40 text-destructive max-[479px]:hidden">
            <XCircle aria-hidden className="size-3" />
            {t('rooms:apply.fileConflict')}
          </ApplyChip>
        )}
        {mine && (
          <ApplyChip className="border-warning/40 text-warning max-[479px]:hidden">
            <AlertTriangle aria-hidden className="size-3" />
            {t('rooms:apply.fileDirty')}
          </ApplyChip>
        )}
        <span
          className={cn(
            'shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium',
            STATUS_TONE[f.status]
          )}
        >
          {t(`rooms:apply.status.${f.status}`)}
        </span>
        {!f.binary && (
          <span className="hidden min-w-[7ch] shrink-0 text-right whitespace-nowrap font-mono text-xs tabular-nums min-[420px]:inline">
            <span className="text-diff-add">+{f.additions}</span>{' '}
            <span className="text-diff-del">−{f.deletions}</span>
          </span>
        )}
      </div>
      {isOpen && (
        <div className="border-t border-border">
          <FileDiff file={f} t={t} />
        </div>
      )}
    </li>
  )
}
