import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'

/** How long a recheck may run before the person is offered "Check again". */
export const RECHECK_STALL_MS = 60_000

/**
 * A finished task being checked: "Checking again…" while the check runs (it
 * restarts by itself after the app was closed), and "Check again" if it has
 * stood still for about a minute.
 */
export function RecheckNotice({
  taskId,
  stateKey,
  busy,
  stallMs = RECHECK_STALL_MS,
  onCheckAgain,
}: {
  taskId: string
  /** Changes whenever the task's status or verdict moves. */
  stateKey: string
  busy?: boolean
  stallMs?: number
  onCheckAgain: () => void
}) {
  const { t } = useTranslation()
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    setStalled(false)
    const timer = setTimeout(() => setStalled(true), stallMs)
    return () => clearTimeout(timer)
  }, [stateKey, stallMs])
  return (
    <div
      role="status"
      data-testid={`campaign-recheck-${taskId}`}
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <Loader2 aria-hidden className="size-3.5 motion-safe:animate-spin" />
      <span>
        {stalled
          ? t('settings:campaigns.board.recheck.stalled')
          : t('settings:campaigns.board.recheck.again')}
      </span>
      {stalled && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          data-testid={`campaign-recheck-button-${taskId}`}
          onClick={onCheckAgain}
        >
          {t('settings:campaigns.board.recovery.checkAgain')}
        </Button>
      )}
    </div>
  )
}

/**
 * A task that waits for a task that was skipped. It cannot start by itself,
 * so it says why and offers the two ways out.
 */
export function StrandedNotice({
  taskId,
  skipped,
  busy,
  onSkipToo,
  onRunWithout,
}: {
  taskId: string
  /** Titles of the skipped tasks it waits for. */
  skipped: readonly string[]
  busy?: boolean
  onSkipToo: () => void
  onRunWithout: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      data-testid={`campaign-stranded-${taskId}`}
      className="flex flex-col gap-2 rounded-lg border-[0.8px] border-warning/40 bg-warning/5 p-3"
    >
      <p className="text-xs text-foreground">
        {t('settings:campaigns.board.stranded.explain', {
          tasks: skipped.join(', '),
        })}
      </p>
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          data-testid={`campaign-skip-too-${taskId}`}
          onClick={onSkipToo}
        >
          {t('settings:campaigns.board.stranded.skipToo')}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          data-testid={`campaign-run-without-${taskId}`}
          onClick={onRunWithout}
        >
          {t('settings:campaigns.board.stranded.runWithout')}
        </Button>
      </div>
    </div>
  )
}
