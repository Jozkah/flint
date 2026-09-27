import { useState } from 'react'
import { ChevronDown, ExternalLink, RefreshCw, X } from 'lucide-react'
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
import { usePrStatusView, usePrStatusStore, type PrStatus } from '@/stores/pr-status-store'

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
  const status = pr.state === 'open' ? 'pr' : pr.state

  return (
    <div
      data-testid="pr-bar"
      data-state={pr.state}
      className={cn(
        'flex min-h-[38px] items-center gap-2.5 rounded-[10px] bg-muted py-1 pr-1.5 pl-3 text-[0.78rem] shadow-[inset_0_0_0_.8px_var(--border)] motion-safe:animate-rise-in',
        pr.state === 'open' && 'shadow-[inset_0_0_0_.8px_color-mix(in_oklab,var(--success)_35%,var(--border))]',
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
