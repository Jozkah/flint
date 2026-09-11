import { IconBolt, IconCircleDashed, IconQuestionMark } from '@tabler/icons-react'
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
 * cache, as the provider reported it.
 *
 * Never colour alone: the state is in words, the icon differs per state, and
 * the accessible label and tooltip carry the exact Input, Cached, Uncached,
 * Output and Total values.
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
  if (status === 'reused' && pct !== undefined) shown += ` ${formatPercent(pct)}`
  const counts =
    several && hits !== undefined
      ? ` Cache reused on ${hits} of ${requests} requests.`
      : ''
  const partial =
    status === 'reused' && usage?.cachedInputTokens === undefined
      ? ' Not every request reported its cached count, so no cached total is shown.'
      : ''
  const detail = `${TEXT[status]}. ${exactUsageText(usage)}.${counts}${partial}`
  const Icon =
    status === 'reused' ? IconBolt : status === 'none' ? IconCircleDashed : IconQuestionMark
  return (
    <span
      role="img"
      aria-label={detail}
      title={detail}
      data-testid={testId}
      data-cache-status={status}
      data-cache-percent={pct !== undefined ? pct.toFixed(2) : undefined}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1 py-px text-[10px] leading-tight',
        status === 'reused' && 'border-emerald-600/50 text-emerald-700 dark:text-emerald-400',
        status === 'none' && 'border-border text-muted-foreground',
        status === 'not-reported' && 'border-dashed border-border text-muted-foreground italic',
        className
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span>{shown}</span>
    </span>
  )
}
