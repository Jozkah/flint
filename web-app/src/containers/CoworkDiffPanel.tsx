import { useEffect, useMemo, useState } from 'react'
import { findFocusedRow } from '@/lib/coworkDiffs'
import type { OriginEntry } from '@/lib/coworkOrigins'
import { ChevronDown, GitBranch, Maximize2, Minimize2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { DiffView } from '@/components/DiffView'
import { CoworkSidePanel } from '@/containers/CoworkSidePanel'
import { CoworkApplyAllDialog, type SandboxApplyActions } from '@/containers/CoworkApplyAllDialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { CoworkFileDiff } from '@/lib/coworkDiffs'
import type { SandboxApplyOutcome, SandboxApplyPlan } from '@/lib/coworkSandboxApply'
import { repoName, statusBadge, type GitScope } from '@/lib/coworkGit'
import type { CoworkGitState } from '@/hooks/useCoworkGitStatus'
import { groupSessionFiles } from '@/lib/coworkDiffGroups'
import { LazyGitDiff } from './cowork-diff/LazyGitDiff'
import { FileRow } from './cowork-diff/FileRow'
import { SandboxApply } from './cowork-diff/SandboxApply'
import { statusColor } from '@/lib/coworkDiffGroups'

const SCOPES: GitScope[] = ['working', 'staged', 'all']

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
  onApplyFile,
  applyPlanFor,
  isSandboxPath,
  header,
  footer,
  branch,
  projectName,
  focusPath,
  applyActions,
  onOpenExternal,
  displayPath,
}: {
  /** A session file's short form: relative to the sandbox, as tool cards show it. */
  displayPath?: (path: string) => string
  /**
   * Open a changed file in its default app: `git` rows are relative to the
   * project, `session` rows are the paths the run wrote.
   */
  onOpenExternal?: (path: string, source: 'git' | 'session') => void
  /**
   * Dry run and apply for "Apply all to folder". Absent: no Apply all (no
   * folder, or no session to resolve the sandbox from).
   */
  applyActions?: SandboxApplyActions
  /**
   * A file to bring into view and expand, e.g. from a tool card's "Open
   * diff". Matched by path, whichever list it is in.
   */
  focusPath?: string | null
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
  /**
   * Copy a sandbox file into the attached folder. Absent when there is no
   * folder to copy into.
   */
  onApplyFile?: (path: string, overwrite: boolean) => Promise<SandboxApplyOutcome>
  /**
   * Where a sandbox file would be copied, or null when it cannot be (a file
   * Flint edited in place, outside the sandbox). No plan, no Apply button:
   * one that can only fail is worse than none.
   */
  applyPlanFor?: (path: string) => SandboxApplyPlan | null
  /**
   * Whether a changed file is in the session sandbox. Files that are not were
   * edited in place and get their own section. Absent: all are sandbox files.
   */
  isSandboxPath?: (path: string) => boolean
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
  const [applyAllOpen, setApplyAllOpen] = useState(false)

  const gitFiles = useMemo(() => git.status?.files ?? [], [git.status])
  const originByPath = useMemo(
    () => new Map((origins ?? []).map((one) => [one.path, one])),
    [origins]
  )
  const showProject = !!folder
  const showSandbox = sandboxFiles.length > 0
  // Files Flint edited where they live are not sandbox output: listing them
  // under "Session sandbox" said the real project was untouched.
  const sessionGroups = useMemo(
    () => groupSessionFiles(sandboxFiles, isSandboxPath, t, displayPath),
    [sandboxFiles, isSandboxPath, t, displayPath]
  )
  // One list per file: a file the session's own list names (with Apply) is
  // not listed again under the project's working tree. Only when the working
  // tree has nothing else does its section go; a clean tree still says so.
  const sessionPaths = useMemo(
    () =>
      new Set(sessionGroups.flatMap((g) => g.files.map((f) => g.show(f.path)))),
    [sessionGroups]
  )
  const projectFiles = useMemo(
    () => gitFiles.filter((f) => !sessionPaths.has(f.path)),
    [gitFiles, sessionPaths]
  )
  const projectAllListedBelow =
    gitFiles.length > 0 && projectFiles.length === 0
  const showProjectSection = showProject && !projectAllListedBelow
  const labelled = (showProjectSection ? 1 : 0) + sessionGroups.length > 1

  // Combined totals across both sources for the header summary, each file
  // counted once.
  const sandboxAdds = sandboxFiles.reduce((s, f) => s + f.additions, 0)
  const sandboxDels = sandboxFiles.reduce((s, f) => s + f.deletions, 0)
  const listedTwice = gitFiles.filter((f) => sessionPaths.has(f.path))
  const additions =
    (git.status?.additions ?? 0) -
    listedTwice.reduce((s, f) => s + f.additions, 0) +
    sandboxAdds
  const deletions =
    (git.status?.deletions ?? 0) -
    listedTwice.reduce((s, f) => s + f.deletions, 0) +
    sandboxDels

  // Stable id per row so one expansion set spans both lists.
  const allIds = useMemo(
    () => [
      ...projectFiles.map((f) => `git:${f.path}`),
      ...sandboxFiles.map((f) => `sandbox:${f.path}`),
    ],
    [projectFiles, sandboxFiles]
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

  // Bring the requested file into view, expanded.
  useEffect(() => {
    if (!focusPath) return
    const id = findFocusedRow(allIds, focusPath)
    if (!id) return
    setExpanded((current) => (current.has(id) ? current : new Set(current).add(id)))
    const row = document.querySelector<HTMLElement>(
      `[data-row-id="${CSS.escape(id)}"]`
    )
    row?.scrollIntoView?.({ block: 'center' })
  }, [focusPath, allIds])

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
            className="inline-flex h-[22px] min-w-0 items-center gap-1.5 rounded-md border-[0.8px] border-border bg-card px-2 font-mono text-[length:calc(var(--ui-font-base)*0.6875)] text-secondary-foreground"
            title={branchName}
          >
            <GitBranch size={12} className="shrink-0" />
            <span className="truncate">{branchName}</span>
          </span>
        ) : undefined
      }
      summary={
        <span
          className="flex shrink-0 gap-1 font-mono text-[length:calc(var(--ui-font-base)*0.65625)] font-medium tabular-nums"
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
            {/* The comparison only changes the Git list: shown for a
                repository, and labelled as the project's. */}
            {git.status ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t('common:changes.scopeLabel')}
                title={t('common:changes.scopeLabel')}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border-[0.8px] border-border bg-card px-2.5 text-xs font-medium text-secondary-foreground outline-none transition-[box-shadow,color] hover:text-foreground hover:shadow-lift focus-visible:ring-[3px] focus-visible:ring-ring/40 data-[state=open]:shadow-lift">
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
            ) : null}
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
          {showProjectSection ? (
            <section>
              {labelled ? (
                <h3 className="sticky top-0 z-[1] bg-card px-3 pt-2 pb-1.5 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
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
                  {projectFiles.map((file) => {
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
                        rowId={id}
                        path={file.path}
                        onOpen={
                          onOpenFile ? () => onOpenFile(file.path) : undefined
                        }
                        onOpenExternal={
                          onOpenExternal
                            ? () => onOpenExternal(file.path, 'git')
                            : undefined
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
                            claimsChanges={
                              file.additions + file.deletions > 0
                            }
                            onStale={git.refresh}
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
          {sessionGroups.map((group) => {
            // Apply all sits in the sandbox section's header, offered only
            // when at least one of its files can be applied.
            const applyAll =
              group.key === 'sandbox' &&
              applyActions &&
              group.files.some((f) => applyActions.planFor(f.path))
            return (
            <section key={group.key}>
              {labelled || applyAll ? (
                <div className="sticky top-0 z-[1] flex items-center gap-2 bg-card px-3 pt-2 pb-1.5">
                  <h3 className="min-w-0 flex-1 truncate text-[length:calc(var(--ui-font-base)*0.6875)] font-medium tracking-[0.025em] text-subtle-foreground uppercase" title={group.title}>
                    {labelled ? group.title : null}
                  </h3>
                  {applyAll ? (
                    <button
                      type="button"
                      data-testid="apply-all"
                      onClick={() => setApplyAllOpen(true)}
                      className="shrink-0 rounded-md border-[0.8px] border-border bg-card px-2 py-0.5 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium text-secondary-foreground hover:text-foreground"
                    >
                      {t('common:changes.applyAll')}
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div>
                {group.files.map((file) => {
                  const id = `sandbox:${file.path}`
                  const isExpanded = expanded.has(id)
                  const plan =
                    onApplyFile && group.key === 'sandbox'
                      ? applyPlanFor?.(file.path)
                      : null
                  return (
                    <FileRow
                      key={id}
                      rowId={id}
                      path={group.show(file.path)}
                      onOpen={
                        onOpenFile ? () => onOpenFile(file.path) : undefined
                      }
                      onOpenExternal={
                        onOpenExternal
                          ? () => onOpenExternal(file.path, 'session')
                          : undefined
                      }
                      after={
                        onApplyFile && plan ? (
                          <SandboxApply
                            path={file.path}
                            plan={plan}
                            onApply={onApplyFile}
                          />
                        ) : undefined
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
                          ) : operation.source === 'user' ? (
                            <p
                              className="px-3 pt-2 text-xs text-muted-foreground"
                              data-testid="diff-op-by-user"
                            >
                              {t('common:codePanel.editedByYou')}
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
            )
          })}
          {applyActions ? (
            <CoworkApplyAllDialog
              open={applyAllOpen}
              onOpenChange={setApplyAllOpen}
              paths={sessionGroups
                .filter((g) => g.key === 'sandbox')
                .flatMap((g) => g.files.map((f) => f.path))}
              actions={applyActions}
            />
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

