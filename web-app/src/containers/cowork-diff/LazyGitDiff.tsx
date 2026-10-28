import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { DiffView } from '@/components/DiffView'
import { loadGitFileDiff, type GitFileDiff, type GitScope } from '@/lib/coworkGit'

/**
 * A file's diff loaded only while its row is expanded. Keyed by the panel on
 * `nonce`+`scope`+`path`, so collapsing unmounts it and a refresh or scope
 * change refetches — the "load lazily when expanded" contract, with no cache to
 * go stale.
 */
export function LazyGitDiff({
  folder,
  path,
  scope,
  claimsChanges,
  onStale,
}: {
  folder: string
  path: string
  scope: GitScope
  /** The row this diff belongs to reported added or removed lines. */
  claimsChanges: boolean
  /**
   * The status list is older than the tree: called once when a row that
   * claimed changes turns out to have none, so the list is re-read instead of
   * showing counts above an empty body.
   */
  onStale?: () => void
}) {
  const { t } = useTranslation()
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; diff: GitFileDiff }
    | { status: 'error' }
  >({ status: 'loading' })

  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    loadGitFileDiff(folder, path, scope)
      .then((diff) => {
        if (alive) setState({ status: 'ready', diff })
      })
      .catch(() => {
        if (alive) setState({ status: 'error' })
      })
    return () => {
      alive = false
    }
  }, [folder, path, scope])

  // The status is only re-read on demand, so a commit or undo made after it was
  // loaded leaves rows whose counts no longer exist. An empty diff under such a
  // row means the list is stale, not that the change has nothing to show.
  const stale =
    state.status === 'ready' &&
    !state.diff.binary &&
    !state.diff.diff.trim() &&
    claimsChanges
  useEffect(() => {
    if (stale) onStale?.()
    // Once per load: the panel re-keys this component after the refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale])

  if (state.status === 'loading') {
    return (
      <p className="px-3 py-2.5 text-xs text-muted-foreground">
        {t('common:changes.loadingDiff')}
      </p>
    )
  }
  if (state.status === 'error') {
    return (
      <p className="px-3 py-2 text-xs text-destructive">
        {t('common:changes.diffError')}
      </p>
    )
  }
  const { diff } = state
  if (diff.binary) {
    return (
      <p className="px-3 py-2.5 text-xs text-muted-foreground">
        {t('common:changes.binary')}
      </p>
    )
  }
  if (!diff.diff.trim()) {
    return (
      <p className="px-3 py-2.5 text-xs text-muted-foreground">
        {stale ? t('common:changes.staleRow') : t('common:changes.noDiff')}
      </p>
    )
  }
  return (
    <DiffView diff={diff.diff} className="max-h-none rounded-none border-0" />
  )
}
