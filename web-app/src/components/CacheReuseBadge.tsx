import { cn } from '@/lib/utils'
import {
  cacheReusePercent,
  cacheStatus,
  exactUsageText,
  type CacheStatus,
  type TokenUsage,
} from '@/lib/tokenUsage'

const TEXT: Record<CacheStatus, string> = {
  reused: 'Cache reused',
  none: 'No cached input',
  'not-reported': 'Not reported',
}

export const formatPercent = (pct: number): string =>
  pct > 0 && pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`

/**
 * Prompt-cache usage rendered in the same quiet text treatment as token usage.
 * Exact counts remain available through the accessible label and tooltip.
 */
export function CacheReuseBadge({
  usage,
  hideUnreported,
  className,
  testId = 'cache-status',
}: {
  usage: TokenUsage | undefined
  hideUnreported?: boolean
  className?: string
  testId?: string
}) {
  const status = cacheStatus(usage)
  if (hideUnreported && status === 'not-reported') return null
  const pct = cacheReusePercent(usage)
  const hits = usage?.cacheHitRequests
  const requests = usage?.requests
  const several = requests !== undefined && requests > 1
  let shown = TEXT[status]
  if (status === 'reused' && pct !== undefined)
    shown = `${formatPercent(pct)} input cached`
  const counts =
    several && hits !== undefined
      ? ` Cache reused on ${hits} of ${requests} requests.`
      : ''
  const partial =
    status === 'reused' && usage?.cachedInputTokens === undefined
      ? ' Not every request reported its cached count, so no cached total is shown.'
      : ''
  const detail = `${TEXT[status]}. ${exactUsageText(usage)}.${counts}${partial}`

  return (
    <span
      aria-label={detail}
      title={detail}
      data-testid={testId}
      data-cache-status={status}
      data-cache-percent={pct !== undefined ? pct.toFixed(2) : undefined}
      className={cn(
        'inline-flex items-center text-xs font-normal tabular-nums text-muted-foreground',
        status === 'not-reported' && 'italic',
        className
      )}
    >
      {shown}
    </span>
  )
}
