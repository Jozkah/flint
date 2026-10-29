import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Preflight } from '@/lib/rooms/applyReview'

type T = (key: string, options?: Record<string, unknown>) => string

type Props = {
  check: Preflight
  /** Selected files the user has uncommitted edits in. */
  dirty: string[]
  onLeaveOutConflicts: () => void
  t: T
}

/**
 * The dry run's verdict. One quiet line while checking or when all is well;
 * a card with one row per issue otherwise.
 */
export function PreflightPanel({ check, dirty, onLeaveOutConflicts, t }: Props): React.ReactElement {
  const hasIssues = check.state === 'conflict' || check.state === 'failed' || dirty.length > 0
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="apply-preflight"
      data-state={check.state}
      className={cn(
        hasIssues && 'flex flex-col divide-y divide-border rounded-lg border-[0.8px] border-border bg-card'
      )}
    >
      {check.state === 'checking' && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          {t('rooms:apply.checking')}
        </p>
      )}
      {check.state === 'clean' && (
        <p className={cn('flex items-center gap-2 text-xs font-medium text-success', hasIssues && 'px-3.5 py-3')}>
          <CheckCircle2 aria-hidden className="size-3.5" />
          {t('rooms:apply.clean')}
        </p>
      )}
      {check.state === 'failed' && (
        <div className="flex items-start gap-2.5 px-3.5 py-3 text-xs">
          <XCircle aria-hidden className="mt-px size-4 shrink-0 text-destructive" />
          <p className="min-w-0 break-words text-foreground">{t('rooms:apply.checkFailed', { message: check.message })}</p>
        </div>
      )}
      {check.state === 'conflict' && (
        <div className="flex flex-col gap-2 px-3.5 py-3 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="flex min-w-0 basis-full items-center gap-2.5 sm:flex-1 sm:basis-auto">
              <XCircle aria-hidden className="size-4 shrink-0 text-destructive" />
              <span className="font-medium text-foreground">
                {t('rooms:apply.conflict', { count: check.conflicts.length })}
              </span>
            </p>
            <Button
              size="xs"
              variant="outline"
              data-testid="apply-leave-out"
              className="ml-[26px] self-start sm:ml-0"
              onClick={onLeaveOutConflicts}
            >
              {t('rooms:apply.leaveOut')}
            </Button>
          </div>
          <p className="pl-[26px] text-muted-foreground">{t('rooms:apply.conflictHint')}</p>
          <details className="group/d pl-[26px]">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronDown aria-hidden className="size-3.5 -rotate-90 transition-transform group-open/d:rotate-0" />
              {t('rooms:apply.details')}
            </summary>
            <ul className="mt-2 flex flex-col gap-1 rounded-md bg-code-bg px-3 py-2 font-mono">
              {check.conflicts.map((c) => (
                <li key={c.path} className="min-w-0 break-words">
                  <span className="text-foreground">{c.path}</span>
                  <span className="text-muted-foreground"> — {c.reason ?? t('rooms:apply.notChecked')}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
      {dirty.length > 0 && (
        <div data-testid="apply-dirty" className="flex flex-col gap-1 px-3.5 py-3 text-xs">
          <p className="flex items-center gap-2.5">
            <AlertTriangle aria-hidden className="size-4 shrink-0 text-warning" />
            <span className="font-medium text-foreground">{t('rooms:apply.dirtyTitle', { count: dirty.length })}</span>
          </p>
          <p className="min-w-0 pl-[26px] font-mono break-words text-muted-foreground">{dirty.join(', ')}</p>
          <p className="pl-[26px] text-muted-foreground">{t('rooms:apply.dirtyHint')}</p>
        </div>
      )}
    </div>
  )
}
