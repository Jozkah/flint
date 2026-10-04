/* eslint-disable react-refresh/only-export-components */
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

/** "97.3%" -- one decimal below 10%, whole numbers above. */
export const formatPercent = (pct: number): string =>
  pct > 0 && pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`

/**
 * Whether a request (or a turn, or a session) read from the provider's prompt
 * cache, as the provider reported it, rendered in the same quiet text
 * treatment as token usage.
 *
 * Never colour alone: the state is in words, and the accessible label and
 * tooltip carry the exact Input, Cached, Uncached, Output and Total values.
 */
export function CacheReuseBadge({
  usage,
  hideUnreported,
  className,
  testId = 'cache-status',
}: {
  usage: TokenUsage | undefined
  /** Draw nothing when the provider did not report the cache (compact rows). */
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
  const reportedRequests = usage?.cacheReportedRequests
  const partial =
    several && reportedRequests !== undefined && reportedRequests < requests
      ? ` Only ${reportedRequests} of ${requests} requests reported cache info; the share is of their input.`
      : ''
  const detail = `${TEXT[status]}. ${exactUsageText(usage)}.${counts}${partial}`

  return (
    <span
      role="img"
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
