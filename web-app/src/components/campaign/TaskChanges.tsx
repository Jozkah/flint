import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { DiffView } from '@/components/DiffView'
import { cn } from '@/lib/utils'
import type { TaskDiff, TaskDiffFile } from '@/lib/campaignApi'
import {
  fallbackDiff,
  kindOf,
  lineCounts,
  previewPatch,
  splitPath,
  totalsOf,
} from '@/lib/campaignDiff'
import { errorText } from '@/lib/errorText'

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; diff: TaskDiff; counted: boolean }
  | { phase: 'failed'; reason: string }

/**
 * What one task changed: a totals line, one row per file with its kind and
 * counted lines, and each file's diff behind its row. Git is asked first; if
 * it cannot answer, the file names the session's tool activity recorded are
 * listed instead, and the panel says that is all it has.
 */
export function TaskChanges({
  load,
  recordedFiles,
}: {
  load: () => Promise<TaskDiff>
  /** Names from the session's recorded tool activity. */
  recordedFiles: readonly string[]
}) {
  const { t } = useTranslation()
  const [state, setState] = useState<State>({ phase: 'loading' })
  useEffect(() => {
    let alive = true
    setState({ phase: 'loading' })
    load()
      .then((diff) => alive && setState({ phase: 'ready', diff, counted: true }))
      .catch((e) => {
        if (!alive) return
        // Git could not say: the recorded names are the next best thing.
        if (recordedFiles.length > 0) {
          setState({
            phase: 'ready',
            diff: fallbackDiff(recordedFiles),
            counted: false,
          })
        } else {
          setState({ phase: 'failed', reason: errorText(e) })
        }
      })
    return () => {
      alive = false
    }
    // `load` is stable per task; the recorded names only matter on failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  if (state.phase === 'loading') {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {t('settings:campaigns.changes.loading')}
      </p>
    )
  }
  if (state.phase === 'failed') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="changes-empty">
        {t('settings:campaigns.changes.unavailable')}
      </p>
    )
  }
  const { diff, counted } = state
  if (diff.files.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="changes-empty">
        {t('settings:campaigns.changes.none')}
      </p>
    )
  }
  const totals = totalsOf(diff)
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <p className="text-sm" data-testid="changes-totals">
        {t('settings:campaigns.changes.files', { count: totals.files })}
        {counted ? (
          <>
            <span className="text-muted-foreground"> {'·'} </span>
            <span className="tabular-nums">
              {lineCounts(totals.added, totals.removed)}
            </span>
          </>
        ) : null}
      </p>
      {!counted && (
        <p className="text-xs text-muted-foreground">
          {t('settings:campaigns.changes.namesOnly')}
        </p>
      )}
      {diff.uncommitted && (
        <p className="text-xs text-muted-foreground">
          {t('settings:campaigns.changes.uncommitted')}
        </p>
      )}
      <ul className="flex max-h-[60vh] min-h-0 flex-col gap-1 overflow-y-auto">
        {diff.files.map((f) => (
          <FileRow key={f.path} file={f} counted={counted} />
        ))}
      </ul>
      {diff.truncated && (
        <p className="text-xs text-muted-foreground">
          {t('settings:campaigns.changes.cut')}
        </p>
      )}
    </div>
  )
}

function FileRow({ file, counted }: { file: TaskDiffFile; counted: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  const { dir, name } = splitPath(file.path)
  const kind = kindOf(file)
  const expandable = counted
  const preview = file.patch ? previewPatch(file.patch) : null
  const patch = file.patch
    ? all || !preview || preview.hidden === 0
      ? file.patch
      : preview.text
    : null
  return (
    <li
      className="rounded-lg border-[0.8px] border-border"
      data-testid={`changes-file-${file.path}`}
    >
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        {expandable && (
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90'
            )}
          />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          <span className="text-muted-foreground">{dir}</span>
          <span>{name}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t(`settings:campaigns.changes.kind.${kind}`)}
        </span>
        {counted && (
          <span className="shrink-0 text-xs tabular-nums">
            {file.binary
              ? t('settings:campaigns.changes.binary')
              : lineCounts(file.added, file.removed)}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t-[0.8px] border-border p-2">
          {kind === 'renamed' && file.oldPath && (
            <p className="px-1 text-xs text-muted-foreground">
              {t('settings:campaigns.changes.renamedFrom', { from: file.oldPath })}
            </p>
          )}
          {patch ? (
            <>
              <DiffView diff={patch} />
              {preview && preview.hidden > 0 && !all && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => setAll(true)}
                >
                  {t('settings:campaigns.changes.showMore', {
                    count: preview.hidden,
                  })}
                </Button>
              )}
              {file.truncated && (
                <p className="px-1 text-xs text-muted-foreground">
                  {t('settings:campaigns.changes.fileCut')}
                </p>
              )}
            </>
          ) : (
            <p className="px-1 text-xs text-muted-foreground">
              {file.binary
                ? t('settings:campaigns.changes.binaryNote')
                : file.truncated
                  ? t('settings:campaigns.changes.fileCut')
                  : t('settings:campaigns.changes.noPatch')}
            </p>
          )}
        </div>
      )}
    </li>
  )
}
