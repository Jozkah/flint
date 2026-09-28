import { useState } from 'react'
import { ChevronDown, ExternalLink, GitMerge, RefreshCw, Wrench, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ThreadStatusMark } from '@/containers/ThreadStatusMark'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  usePrStatusView,
  usePrStatusStore,
  prRelation,
  type CheckRun,
  type PrStatus,
} from '@/stores/pr-status-store'
import { useMessageQueue } from '@/stores/message-queue-store'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import {
  canFixCheck,
  canResolveConflicts,
  orderedChecks,
  requestCheckRepair,
  requestConflictResolution,
  type CheckLog,
} from '@/lib/prCheckRepair'

/** Named checks shown in the menu; the counts above cover the rest. */
const MAX_LISTED_CHECKS = 12

const fmt = (n: number) => n.toLocaleString()

function CiDot({ checks }: { checks: PrStatus['checks'] }) {
  const cls =
    checks.failed > 0
      ? 'bg-destructive'
      : checks.pending > 0
        ? 'bg-warning motion-safe:animate-pulse'
        : checks.passed > 0
          ? 'bg-success'
          : 'shadow-[inset_0_0_0_1.5px_var(--subtle-foreground)]'
  return <i aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', cls)} />
}

const VERDICT_DOT: Record<CheckRun['verdict'], string> = {
  failed: 'bg-destructive',
  pending: 'bg-warning',
  passed: 'bg-success',
}

/**
 * Queue "Fix this check" into the owning session. The log is fetched through
 * `gh`, bounded, and only while the pull request's head is still the commit
 * the check ran on; a moved head refreshes the status instead.
 */
async function fixCheck(
  folder: string,
  sessionId: string,
  pr: PrStatus,
  check: CheckRun,
  t: (key: string, opts?: Record<string, unknown>) => string
) {
  const { invoke } = await import('@tauri-apps/api/core')
  const outcome = await requestCheckRepair(
    { folder, sessionId, pr, relation: 'mine', check },
    {
      fetchLog: (a) =>
        invoke<CheckLog>('agent_pr_check_log', {
          project: a.project,
          prUrl: a.prUrl,
          headSha: a.headSha,
          jobId: a.jobId,
          detailsUrl: a.detailsUrl,
        }).catch(
          (e): CheckLog => ({
            kind: 'unavailable',
            reason: String(e),
            details_url: a.detailsUrl,
            // The backend never answered, so the head was never confirmed.
            head_verified: false,
          })
        ),
      queue: (sid) => useMessageQueue.getState().getQueue(sid),
      enqueue: (sid, m) => useMessageQueue.getState().enqueue(sid, m),
      refresh: () => {
        void usePrStatusStore.getState().refresh(folder, true)
        void usePrStatusStore.getState().refreshUrl(pr.url, folder, true)
      },
      // The session must still own the pull request once the log is back.
      stillOwns: () => {
        const s = usePrStatusStore.getState()
        const own = s.sessionPrs[sessionId]?.some((p) => p.url === pr.url)
        if (own) return true
        const worktree = useCoworkWorktrees.getState().bySession[sessionId]
        return prRelation(pr, folder, s.claims, sessionId, worktree) === 'mine'
      },
    }
  )
  if (outcome.status === 'queued') toast.success(t('common:pr.fixQueued', { name: check.name }))
  else if (outcome.status === 'duplicate') toast.info(t('common:pr.fixAlreadyQueued'))
  else if (outcome.status === 'stale') toast.warning(t('common:pr.fixStale'))
  else if (outcome.status === 'unverified')
    toast.error(t('common:pr.fixUnverified', { reason: outcome.reason }))
  else toast.error(t('common:pr.fixRefused'))
}

/** Queue "resolve the merge conflicts" into the owning session. */
function resolveConflicts(
  folder: string,
  sessionId: string,
  pr: PrStatus,
  t: (key: string, opts?: Record<string, unknown>) => string
) {
  const outcome = requestConflictResolution(
    { sessionId, pr, relation: 'mine' },
    {
      queue: (sid) => useMessageQueue.getState().getQueue(sid),
      enqueue: (sid, m) => useMessageQueue.getState().enqueue(sid, m),
      stillOwns: () => {
        const s = usePrStatusStore.getState()
        if (s.sessionPrs[sessionId]?.some((p) => p.url === pr.url)) return true
        const worktree = useCoworkWorktrees.getState().bySession[sessionId]
        return prRelation(pr, folder, s.claims, sessionId, worktree) === 'mine'
      },
    }
  )
  if (outcome.status === 'queued') toast.success(t('common:pr.resolveQueued'))
  else if (outcome.status === 'duplicate') toast.info(t('common:pr.resolveAlreadyQueued'))
  else toast.error(t('common:pr.fixRefused'))
}

/**
 * The pull request for a working folder's branch, shown above the composer
 * with the same mark as the sidebar row: number, repository, branch, the
 * diff size and the checks. Nothing is shown without a pull request, or when
 * the GitHub CLI is missing or signed out.
 */
export function PrBar({
  folder,
  sessionId,
  className,
}: {
  folder: string | null | undefined
  /** Hides a pull request another session opened on the same checkout. */
  sessionId?: string | null
  className?: string
}) {
  const { t } = useTranslation()
  const view = usePrStatusView(folder, sessionId)
  const pr = view?.pr
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (!pr || !folder || dismissed === `${folder}#${pr.number}`) return null

  // Opened outside Flint on a checkout this session only shares: named, muted,
  // and nothing more -- it is not this session's work.
  if (view.relation === 'foreign') {
    return (
      <div
        data-testid="pr-bar-foreign"
        className={cn(
          'flex min-h-[30px] items-center gap-2 px-3 text-xs text-muted-foreground',
          className
        )}
      >
        <button
          type="button"
          onClick={() => void getServiceHub().opener().openUrl(pr.url)}
          className="min-w-0 cursor-pointer truncate hover:underline"
          title={pr.title}
        >
          {t('common:pr.notOpenedHere', { number: pr.number, branch: pr.head })}
        </button>
      </div>
    )
  }

  // The pull request's own repository: a session's may be in a clone other
  // than the attached folder.
  const repo =
    /github\.com\/[^/]+\/([^/]+)\/pull\//.exec(pr.url)?.[1] ??
    folder.split(/[\\/]/).filter(Boolean).pop() ??
    folder
  const open = () => void getServiceHub().opener().openUrl(pr.url)
  const listed = orderedChecks(pr.check_runs).slice(0, MAX_LISTED_CHECKS)
  const status = pr.state === 'open' ? 'pr' : pr.state

  return (
    <div
      data-testid="pr-bar"
      data-state={pr.state}
      className={cn(
        'flex min-h-[38px] items-center gap-2.5 rounded-[10px] bg-muted py-1 pr-1.5 pl-3 text-[0.78rem] shadow-[inset_0_0_0_.8px_var(--border)] motion-safe:animate-rise-in',
        pr.state === 'open' && 'shadow-[inset_0_0_0_.8px_color-mix(in_oklab,var(--success)_35%,var(--border))]',
        // Conflicts outrank an open PR's green edge: it cannot merge as is.
        pr.merge === 'conflicting' &&
          (pr.state === 'open' || pr.state === 'draft') &&
          'shadow-[inset_0_0_0_.8px_color-mix(in_oklab,var(--destructive)_45%,var(--border))]',
        pr.state === 'merged' && 'bg-[color-mix(in_oklab,var(--merged)_14%,var(--muted))] shadow-[inset_0_0_0_.8px_color-mix(in_oklab,var(--merged)_30%,transparent)]',
        className
      )}
    >
      <ThreadStatusMark status={status} />
      <button
        type="button"
        onClick={open}
        className={cn(
          'cursor-pointer font-medium text-foreground hover:underline',
          pr.state === 'closed' && 'text-destructive underline underline-offset-2',
          pr.state === 'draft' && 'text-muted-foreground',
          pr.state === 'merged' && 'text-merged'
        )}
      >
        #{pr.number}
      </button>
      <span className={cn('text-muted-foreground', pr.state === 'merged' && 'text-merged/70')}>{repo}</span>
      <span
        className={cn('min-w-0 truncate font-mono text-xs text-secondary-foreground', pr.state === 'merged' && 'text-merged')}
        title={pr.head}
      >
        {pr.head}
      </span>
      {pr.statusError && (
        <span data-testid="pr-bar-status-error" className="shrink-0 text-xs text-destructive" title={pr.statusError}>
          {t('common:pr.statusUnavailable')}
        </span>
      )}
      <span className="flex-1" />
      {pr.state === 'merged' ? (
        <span className="text-[0.78rem] font-medium text-merged">{t('common:pr.merged')}</span>
      ) : (
        <>
          {(pr.merge === 'conflicting' || pr.merge === 'behind') && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="pr-merge-state"
                  data-merge={pr.merge}
                  className={cn(
                    'group/merge gap-1.5',
                    pr.merge === 'conflicting'
                      ? 'border-destructive/40 text-destructive hover:text-destructive'
                      : 'text-muted-foreground'
                  )}
                >
                  <GitMerge className="size-3.5" aria-hidden />
                  {pr.merge === 'conflicting'
                    ? t('common:pr.conflicts')
                    : t('common:pr.behind', { base: pr.base })}
                  <ChevronDown className="size-3 transition-transform group-data-[state=open]/merge:rotate-180" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel>
                  {pr.merge === 'conflicting'
                    ? t('common:pr.conflictsTitle', { base: pr.base })
                    : t('common:pr.behind', { base: pr.base })}
                </DropdownMenuLabel>
                <p className="px-2 pb-1.5 text-xs text-muted-foreground">
                  {pr.merge === 'conflicting'
                    ? t('common:pr.conflictsBody')
                    : t('common:pr.behindBody', { base: pr.base })}
                </p>
                {sessionId && canResolveConflicts(pr, view.relation, sessionId) && (
                  <DropdownMenuItem
                    data-testid="pr-resolve-conflicts"
                    onSelect={() => resolveConflicts(folder, sessionId, pr, t)}
                  >
                    <Wrench />
                    <span>{t('common:pr.resolveConflicts')}</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={open}>
                  <ExternalLink />
                  <span>{t('common:pr.open')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <span className="inline-flex h-[26px] items-center gap-1.5 rounded-md bg-card px-2 font-mono text-xs font-medium shadow-[inset_0_0_0_.8px_var(--border)]">
            <span className="text-success">+{fmt(pr.additions)}</span>
            <span className="text-destructive">−{fmt(pr.deletions)}</span>
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="group/ci gap-1.5">
                <CiDot checks={pr.checks} />
                CI
                <ChevronDown className="size-3 transition-transform group-data-[state=open]/ci:rotate-180" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>
                {pr.checks.passed + pr.checks.failed + pr.checks.pending === 0
                  ? t('common:pr.noChecks')
                  : t('common:pr.checks')}
              </DropdownMenuLabel>
              {pr.checks.passed > 0 && (
                <div className="flex items-center gap-2.5 px-2 py-1.5 text-[0.78rem]">
                  <i className="size-2 rounded-full bg-success" /> {t('common:pr.passed', { count: pr.checks.passed })}
                </div>
              )}
              {pr.checks.failed > 0 && (
                <div className="flex items-center gap-2.5 px-2 py-1.5 text-[0.78rem]">
                  <i className="size-2 rounded-full bg-destructive" /> {t('common:pr.failed', { count: pr.checks.failed })}
                </div>
              )}
              {pr.checks.pending > 0 && (
                <div className="flex items-center gap-2.5 px-2 py-1.5 text-[0.78rem]">
                  <i className="size-2 rounded-full bg-warning" /> {t('common:pr.pending', { count: pr.checks.pending })}
                </div>
              )}
              {listed.length > 0 && <DropdownMenuSeparator />}
              {listed.map((check, i) => {
                const fixable = !!sessionId && canFixCheck(pr, view.relation, sessionId, check)
                return (
                  <div
                    key={`${check.name}-${i}`}
                    data-testid="pr-check"
                    data-verdict={check.verdict}
                    className="flex flex-col gap-0.5 px-2 py-1 text-[0.78rem]"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <i className={cn('size-2 shrink-0 rounded-full', VERDICT_DOT[check.verdict])} />
                      <span className="min-w-0 truncate" title={check.workflow ? `${check.workflow} / ${check.name}` : check.name}>
                        {check.name}
                      </span>
                    </div>
                    {check.verdict === 'failed' && (
                      <div className="flex items-center gap-1 pl-4.5">
                        {fixable && (
                          <DropdownMenuItem
                            data-testid="pr-check-fix"
                            className="h-6 px-1.5 py-0 text-xs"
                            onSelect={() => void fixCheck(folder, sessionId!, pr, check, t)}
                          >
                            <Wrench />
                            <span>{t('common:pr.fixCheck')}</span>
                          </DropdownMenuItem>
                        )}
                        {check.details_url && (
                          <DropdownMenuItem
                            data-testid="pr-check-details"
                            className="h-6 px-1.5 py-0 text-xs"
                            onSelect={() => void getServiceHub().opener().openUrl(check.details_url!)}
                          >
                            <ExternalLink />
                            <span>{t('common:pr.checkDetails')}</span>
                          </DropdownMenuItem>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  void usePrStatusStore.getState().refresh(folder, true)
                  void usePrStatusStore.getState().refreshUrl(pr.url, folder, true)
                }}
              >
                <RefreshCw />
                <span>{t('common:pr.refresh')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={open}>
                <ExternalLink />
                <span>{t('common:pr.open')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('common:pr.dismiss')}
        onClick={() => setDismissed(`${folder}#${pr.number}`)}
      >
        <X />
      </Button>
    </div>
  )
}
