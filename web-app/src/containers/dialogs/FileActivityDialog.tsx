import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  FileCode,
  FilePen,
  FilePlus,
  FileSearch,
  FileX,
  FolderTree,
  Search,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { TONE_CLASSES } from '@/lib/semanticTone'
import type { OriginEntry } from '@/lib/coworkOrigins'
import {
  countsByFilter,
  groupByFile,

  type FileActivityEvent,
  type FileActivityFilter,
  type FileActivityGroup,
  type FileOperation,
} from '@/lib/fileActivity'

/** Rows are a fixed height, which is what lets the list virtualize. */
const ROW_HEIGHT = 56

const FILTERS: FileActivityFilter[] = [
  'all',
  'read',
  'changed',
  'created',
  'deleted',
  'failed',
  'project',
  'sandbox',
]

const OPERATION_ICON: Record<FileOperation, typeof FileCode> = {
  read: FileCode,
  list: FolderTree,
  search: FileSearch,
  create: FilePlus,
  write: FilePen,
  edit: FilePen,
  delete: FileX,
  rename: FilePen,
}


/** Beyond this many files, the list virtualizes. Below it, plain DOM reads
 *  better to assistive technology and costs nothing. */
const VIRTUALIZE_ABOVE = 50

function ActivityRow({
  group,
  origin,
  t,
  onOpenFile,
  onOpenDiff,
}: {
  group: FileActivityGroup
  /** What the ledger knows about this file, when it knows anything. */
  origin?: OriginEntry
  t: (key: string, opts?: Record<string, unknown>) => string
  onOpenFile?: (path: string) => void
  onOpenDiff?: (path: string) => void
}) {
  const latest = group.events[group.events.length - 1]
  const Icon = OPERATION_ICON[latest.operation]
  const tone = group.failed
    ? TONE_CLASSES.error
    : group.changed
      ? TONE_CLASSES.write
      : TONE_CLASSES.read
  const openIt = group.changed ? onOpenDiff : onOpenFile

  return (
    <div role="listitem" style={{ height: ROW_HEIGHT }}>
      <button
        type="button"
        disabled={!openIt}
        onClick={() => openIt?.(group.path)}
        className={cn(
          'flex h-full w-full items-center gap-2 rounded-md px-2 text-left',
          openIt ? 'hover:bg-secondary/50' : 'cursor-default'
        )}
      >
        <Icon className={cn('size-4 shrink-0', tone.icon)} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{group.name}</span>
          <span
            className="block truncate font-mono text-xs text-muted-foreground"
            title={group.path}
          >
            {group.path}
          </span>
        </span>
        <span className="shrink-0 text-right text-xs text-muted-foreground">
          {/* Words, not just colour: the state has to survive a greyscale
              screen and a colour-blind reader. */}
          <span className="block">
            {t(`common:fileActivity.operation.${latest.operation}`)}
            {group.failed && ` \u00b7 ${t('common:fileActivity.failed')}`}
          </span>
          <span className="block">
            {t('common:fileActivity.eventCount', {
              count: group.events.length,
            })}
            {' \u00b7 '}
            {t(`common:fileActivity.origin.${group.origin}`)}
          </span>
          {origin ? (
            // What is actually known, from the run's ledger. A row with no
            // entry says nothing rather than being assumed to be Jan's.
            <span className="block">
              {t(
                `common:coworkOrigins.row.${
                  origin.evidence === 'jan-write' && origin.alsoPreExisting
                    ? 'jan-write-over'
                    : origin.evidence
                }`
              )}
            </span>
          ) : null}
        </span>
      </button>
    </div>
  )
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What the conversation did, oldest first. */
  events: FileActivityEvent[]
  title: string
  /** Show a readable file. Absent where there is no code panel. */
  onOpenFile?: (path: string) => void
  /** Focus a changed file's diff. Absent where there is no diff rail. */
  onOpenDiff?: (path: string) => void
  /**
   * The run's origin ledger, when one exists.
   *
   * Activity says what Jan *called*; the ledger says what is known about the
   * result. Without it a failed write and a write someone else made look the
   * same as Jan's own successful one.
   */
  origins?: readonly OriginEntry[]
}

/**
 * What this conversation did to which files.
 *
 * Grouped by file rather than by time, because the question is nearly always
 * "what happened to this file" and a flat log makes that the one thing you
 * cannot see. Reads and writes are told apart by icon, by wording and by
 * position — never by colour alone.
 */
export function FileActivityDialog({
  open,
  onOpenChange,
  events,
  title,
  onOpenFile,
  onOpenDiff,
  origins,
}: Props) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<FileActivityFilter>('all')
  const [search, setSearch] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const originByPath = useMemo(
    () => new Map((origins ?? []).map((one) => [one.path, one])),
    [origins]
  )
  const counts = useMemo(() => countsByFilter(events), [events])
  const groups = useMemo(
    () => groupByFile(events, { filter, search }),
    [events, filter, search]
  )

  const virtualize = groups.length > VIRTUALIZE_ABOVE

  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    // An initial rect means the first paint is measured rather than empty,
    // which also makes the list observable where ResizeObserver is absent.
    initialRect: { width: 640, height: 400 },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('common:fileActivity.title')}</DialogTitle>
          <DialogDescription>
            {t('common:fileActivity.description', { title })}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('common:fileActivity.searchPlaceholder')}
            aria-label={t('common:fileActivity.searchPlaceholder')}
            className="w-full rounded-md border bg-transparent py-1.5 pl-8 pr-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        <div
          role="group"
          aria-label={t('common:fileActivity.filtersLabel')}
          className="flex flex-wrap gap-1"
        >
          {FILTERS.map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'secondary' : 'ghost'}
              className="h-7 px-2 text-xs"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {t(`common:fileActivity.filter.${f}`)}
              <span className="ml-1 tabular-nums text-muted-foreground">
                {counts[f]}
              </span>
            </Button>
          ))}
        </div>

        {groups.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {events.length === 0
              ? t('common:fileActivity.empty')
              : t('common:fileActivity.noMatches')}
          </p>
        ) : virtualize ? (
          <div ref={scrollRef} className="max-h-[50vh] overflow-y-auto" role="list">
            <div
              style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
            >
              {virtualizer.getVirtualItems().map((row) => (
                <div
                  key={groups[row.index].path}
                  className="absolute left-0 top-0 w-full"
                  style={{
                    height: row.size,
                    transform: `translateY(${row.start}px)`,
                  }}
                >
                  <ActivityRow
                    group={groups[row.index]}
                    origin={originByPath.get(groups[row.index].path)}
                    t={t}
                    onOpenFile={onOpenFile}
                    onOpenDiff={onOpenDiff}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto" role="list">
            {groups.map((group) => (
              <ActivityRow
                key={group.path}
                group={group}
                origin={originByPath.get(group.path)}
                t={t}
                onOpenFile={onOpenFile}
                onOpenDiff={onOpenDiff}
              />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

