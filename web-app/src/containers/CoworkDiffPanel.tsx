import { useEffect, useMemo, useState } from 'react'
import type { OriginEntry } from '@/lib/coworkOrigins'
import {
  ChevronDown,
  GitBranch,
  Maximize2,
  Minimize2,
  RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { DiffView } from '@/components/DiffView'
import { CoworkSidePanel } from '@/containers/CoworkSidePanel'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { CoworkFileDiff } from '@/lib/coworkDiffs'
import {
  loadGitFileDiff,
  repoName,
  statusBadge,
  type GitFileDiff,
  type GitFileEntry,
  type GitScope,
} from '@/lib/coworkGit'
import type { CoworkGitState } from '@/hooks/useCoworkGitStatus'

const SCOPES: GitScope[] = ['working', 'staged', 'all']

/** Tint a status tile by kind: added green, deleted red, modified amber. */
function statusColor(status: GitFileEntry['status']): string {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'bg-success-tint text-success'
    case 'deleted':
      return 'bg-destructive-tint text-destructive'
    case 'modified':
    case 'type_changed':
    case 'unmerged':
      return 'bg-warning-tint text-warning'
    default:
      return 'bg-muted text-fg-2'
  }
}

/**
 * A file's diff loaded only while its row is expanded. Keyed by the panel on
 * `nonce`+`scope`+`path`, so collapsing unmounts it and a refresh or scope
 * change refetches — the "load lazily when expanded" contract, with no cache to
 * go stale.
 */
function LazyGitDiff({
  folder,
  path,
  scope,
}: {
  folder: string
  path: string
  scope: GitScope
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
        {t('common:changes.noDiff')}
      </p>
    )
  }
  return (
    <DiffView diff={diff.diff} className="max-h-none rounded-none border-0" />
  )
}

/** A single expandable row shared by the project and sandbox lists. */
function FileRow({
  path,
  subtitle,
  additions,
  deletions,
  badge,
  badgeColor,
  indicator,
  note,
  isExpanded,
  onToggle,
  onOpen,
  children,
}: {
  path: string
  subtitle?: string
  additions: number
  deletions: number
  badge?: string
  badgeColor?: string
  indicator?: string
  /** What is known about who caused this change, when anything is. */
  note?: string
  isExpanded: boolean
  onToggle: () => void
  /** Show this file in the Code panel. Absent where it cannot be opened. */
  onOpen?: () => void
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const openLabel = t('common:changes.openFile')

  return (
    <div className="group/row relative border-b border-dashed border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left text-xs outline-none transition-colors hover:bg-hover-row focus-visible:bg-hover-row pointer-coarse:min-h-11"
      >
        <ChevronDown
          size={12}
          className={cn(
            'shrink-0 text-muted-foreground transition-transform duration-200',
            !isExpanded && '-rotate-90'
          )}
        />
        {badge ? (
          <span
            className={cn(
              'grid size-[18px] shrink-0 place-items-center rounded-[4px] font-mono text-[10.5px] font-semibold',
              badgeColor
            )}
            title={badge}
          >
            {badge}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-xs text-fg-2">{path}</span>
          {subtitle ? (
            <span className="truncate text-[11px] text-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </span>
        {note ? (
          <span className="max-w-[40%] shrink-0 truncate text-[10.5px] text-subtle-foreground">
            {note}
          </span>
        ) : null}
        {indicator ? (
          <span className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] border-[0.8px] border-border bg-card px-1.5 text-[10px] text-muted-foreground">
            {indicator}
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-xs font-medium text-diff-add">
          +{additions}
        </span>
        <span className="shrink-0 font-mono text-xs font-medium text-diff-del">
          −{deletions}
        </span>
      </button>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="absolute top-1.5 right-2 rounded-md bg-card px-1.5 py-0.5 text-[10.5px] text-secondary-foreground opacity-0 shadow-lift transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          {openLabel}
        </button>
      ) : null}
      {isExpanded ? (
        <div className="border-t border-dashed border-border bg-code-bg motion-safe:animate-tree-in">
          {children}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The Cowork "Changes" review panel.
 *
 * Two sources are kept strictly apart and never conflated: the attached
 * repository's real, uncommitted Git working tree ("Project · Working tree")
 * and the files this session wrote into its own writable sandbox ("Cowork
 * output · Session sandbox"). Sandbox writes never touch the attached folder,
 * which is mounted read-only, so the labels make that boundary explicit. When
 * only one source has anything to show, it is shown directly without the
 * section headers.
 *
 * Git status is read-only throughout (see the Rust `git` module): nothing here
 * stages, commits, or otherwise mutates the user's repository. Per-file diffs
 * load lazily when a row is expanded.
 */
export function CoworkDiffPanel({
  sandboxFiles,
  folder,
  git,
  origins,
  onClose,
  onOpenFile,
  header,
  footer,
  branch,
  projectName,
}: {
  sandboxFiles: CoworkFileDiff[]
  /** The attached project's name, used until Git names the repository. */
  projectName?: string
  /** Rendered after the file list: secondary work on changes. */
  footer?: React.ReactNode
  /**
   * The branch the changes are on when Git has not said (a managed worktree's
   * own branch). Git's answer wins when there is one.
   */
  branch?: string | null
  /**
   * Rendered above the file list.
   *
   * Where "go back to how it was" lives, because it is asked in the same
   * breath as "what changed" and answering it anywhere else would mean
   * looking at one panel while acting on another.
   */
  header?: React.ReactNode
  /** Show a changed file in the Code panel. */
  onOpenFile?: (path: string) => void
  folder: string | null
  git: CoworkGitState
  onClose: () => void
  /**
   * What is known about how each of these files came to differ.
   *
   * A file being here means Git sees it as changed — not that Flint changed it.
   * Without the ledger every row reads as the agent's work, which is exactly
   * how someone's own uncommitted changes get handed back to them as Flint's.
   * Absent for a session that has not run yet: then nothing is labelled,
   * rather than everything being labelled wrongly.
   */
  origins?: readonly OriginEntry[]
}): React.ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const gitFiles = useMemo(() => git.status?.files ?? [], [git.status])
  const originByPath = useMemo(
    () => new Map((origins ?? []).map((one) => [one.path, one])),
    [origins]
  )
  const showProject = !!folder
  const showSandbox = sandboxFiles.length > 0
  const labelled = showProject && showSandbox

  // Combined totals across both sources for the header summary.
  const sandboxAdds = sandboxFiles.reduce((s, f) => s + f.additions, 0)
  const sandboxDels = sandboxFiles.reduce((s, f) => s + f.deletions, 0)
  const additions = (git.status?.additions ?? 0) + sandboxAdds
  const deletions = (git.status?.deletions ?? 0) + sandboxDels

  // Stable id per row so one expansion set spans both lists.
  const allIds = useMemo(
    () => [
      ...gitFiles.map((f) => `git:${f.path}`),
      ...sandboxFiles.map((f) => `sandbox:${f.path}`),
    ],
    [gitFiles, sandboxFiles]
  )
  const allExpanded =
    allIds.length > 0 && allIds.every((id) => expanded.has(id))

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleAll = () =>
    setExpanded(() => (allExpanded ? new Set() : new Set(allIds)))

  const name = repoName(git.status)
  const title = showProject
    ? (name ?? projectName ?? t('common:changes.title'))
    : t('common:changes.title')
  const branchName = git.status?.branch ?? branch ?? null

  return (
    <CoworkSidePanel
      data-testid="cowork-diff-panel"
      title={title}
      aside={
        showProject && branchName ? (
          <span
            className="inline-flex h-[22px] min-w-0 items-center gap-1.5 rounded-md border-[0.8px] border-border bg-card px-2 font-mono text-[11px] text-secondary-foreground"
            title={branchName}
          >
            <GitBranch size={12} className="shrink-0" />
            <span className="truncate">{branchName}</span>
          </span>
        ) : undefined
      }
      summary={
        <span
          className="flex shrink-0 gap-1 font-mono text-[10.5px] font-medium tabular-nums"
          data-testid="changes-total"
        >
          <span className="text-diff-add">+{additions}</span>
          <span className="text-diff-del">−{deletions}</span>
        </span>
      }
      onClose={onClose}
    >
      <div className="flex h-full flex-col">
        {header}
        {showProject ? (
          <div className="flex shrink-0 items-center gap-1 px-3 pt-2.5 pb-2">
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex h-7 items-center gap-1.5 rounded-lg border-[0.8px] border-border bg-card px-2.5 text-xs font-medium text-secondary-foreground outline-none transition-[box-shadow,color] hover:text-foreground hover:shadow-lift focus-visible:ring-[3px] focus-visible:ring-ring/40 data-[state=open]:shadow-lift">
                {t(`common:changes.scope.${git.scope}`)}
                <ChevronDown size={12} className="shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup
                  value={git.scope}
                  onValueChange={(v) => git.setScope(v as GitScope)}
                >
                  {SCOPES.map((s) => (
                    <DropdownMenuRadioItem key={s} value={s}>
                      {t(`common:changes.scope.${s}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="ml-auto flex items-center gap-0.5">
              <button
                type="button"
                onClick={toggleAll}
                disabled={allIds.length === 0}
                aria-label={
                  allExpanded
                    ? t('common:changes.collapseAll')
                    : t('common:changes.expandAll')
                }
                title={
                  allExpanded
                    ? t('common:changes.collapseAll')
                    : t('common:changes.expandAll')
                }
                className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover-btn hover:text-foreground disabled:opacity-40"
              >
                {allExpanded ? (
                  <Minimize2 size={14} />
                ) : (
                  <Maximize2 size={14} />
                )}
              </button>
              <button
                type="button"
                onClick={git.refresh}
                aria-label={t('common:changes.refresh')}
                title={t('common:changes.refresh')}
                className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover-btn hover:text-foreground"
              >
                <RefreshCw
                  size={14}
                  className={cn(git.loading && 'motion-safe:animate-spin')}
                />
              </button>
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Project · Working tree */}
          {showProject ? (
            <section>
              {labelled ? (
                <h3 className="sticky top-0 z-[1] bg-card px-3 pt-2 pb-1.5 text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
                  {t('common:changes.projectWorkingTree')}
                </h3>
              ) : null}
              {git.error ? (
                <p className="px-4 py-6 text-center text-sm text-destructive">
                  {t('common:changes.loadError')}
                </p>
              ) : !git.status ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {git.loading
                    ? t('common:changes.loadingStatus')
                    : t('common:changes.noRepo')}
                </p>
              ) : gitFiles.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {t('common:changes.cleanWorkingTree')}
                </p>
              ) : (
                <div>
                  {gitFiles.map((file) => {
                    const id = `git:${file.path}`
                    const isExpanded = expanded.has(id)
                    const origin = originByPath.get(file.path)
                    const indicator =
                      git.scope === 'all' || (file.staged && file.unstaged)
                        ? file.staged && file.unstaged
                          ? t('common:changes.partiallyStaged')
                          : file.staged
                            ? t('common:changes.staged')
                            : t('common:changes.unstaged')
                        : undefined
                    return (
                      <FileRow
                        key={id}
                        path={file.path}
                        onOpen={
                          onOpenFile ? () => onOpenFile(file.path) : undefined
                        }
                        subtitle={
                          file.origPath
                            ? t('common:changes.renamedFrom', {
                                path: file.origPath,
                              })
                            : undefined
                        }
                        additions={file.additions}
                        deletions={file.deletions}
                        badge={statusBadge(file.status)}
                        badgeColor={statusColor(file.status)}
                        indicator={indicator}
                        // Says what is known, and nothing more: a row with no
                        // ledger entry is left unlabelled rather than assumed.
                        note={
                          origin
                            ? t(
                                `common:coworkOrigins.row.${
                                  origin.evidence === 'jan-write' &&
                                  origin.alsoPreExisting
                                    ? 'jan-write-over'
                                    : origin.evidence
                                }`
                              )
                            : undefined
                        }
                        isExpanded={isExpanded}
                        onToggle={() => toggle(id)}
                      >
                        {isExpanded && folder ? (
                          <LazyGitDiff
                            // Refetch on refresh (nonce) or scope change.
                            key={`${git.nonce}:${git.scope}:${file.path}`}
                            folder={folder}
                            path={file.path}
                            scope={git.scope}
                          />
                        ) : null}
                      </FileRow>
                    )
                  })}
                </div>
              )}
            </section>
          ) : null}

          {/* Cowork output · Session sandbox */}
          {showSandbox ? (
            <section>
              {labelled ? (
                <h3 className="sticky top-0 z-[1] bg-card px-3 pt-2 pb-1.5 text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
                  {t('common:changes.sandboxOutput')}
                </h3>
              ) : null}
              <div>
                {sandboxFiles.map((file) => {
                  const id = `sandbox:${file.path}`
                  const isExpanded = expanded.has(id)
                  return (
                    <FileRow
                      key={id}
                      path={file.path}
                      onOpen={
                        onOpenFile ? () => onOpenFile(file.path) : undefined
                      }
                      additions={file.additions}
                      deletions={file.deletions}
                      // Only Flint writes the session sandbox, so this is
                      // known rather than inferred.
                      note={t('common:coworkOrigins.row.jan-write')}
                      isExpanded={isExpanded}
                      onToggle={() => toggle(id)}
                    >
                      {file.operations.map((operation, index) => (
                        <div
                          key={`${file.path}-${index}`}
                          className="border-b border-dashed border-border last:border-b-0"
                        >
                          {operation.source === 'subagent' &&
                          operation.sourceName ? (
                            <p className="px-3 pt-2 text-xs text-muted-foreground">
                              {operation.sourceName}
                            </p>
                          ) : null}
                          <DiffView
                            diff={operation.diff}
                            className="max-h-none rounded-none border-0"
                          />
                        </div>
                      ))}
                    </FileRow>
                  )
                })}
              </div>
            </section>
          ) : null}

          {/* Nothing anywhere. */}
          {!showProject && !showSandbox ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t('common:changes.empty')}
            </p>
          ) : null}
          {footer}
        </div>
      </div>
    </CoworkSidePanel>
  )
}
