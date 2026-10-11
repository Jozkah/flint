import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { CampaignDot } from '@/lib/campaignView'

const COLOR: Record<CampaignDot, string> = {
  queued: 'bg-muted-foreground/50',
  blocked: 'border border-muted-foreground bg-transparent',
  running: 'bg-blue-500 animate-pulse',
  'needs-you': 'bg-yellow-500 motion-safe:animate-pulse',
  verifying: 'bg-violet-500',
  verified: 'bg-emerald-500',
  merged: 'bg-emerald-700',
  failed: 'bg-red-500',
  conflict: 'bg-orange-500',
  cancelled: 'bg-muted-foreground/30',
  planning: 'border border-blue-500 bg-transparent',
  review: 'bg-violet-500',
}

const KEY: Record<CampaignDot, string> = {
  queued: 'queued',
  blocked: 'blocked',
  running: 'running',
  'needs-you': 'needsYou',
  verifying: 'verifying',
  verified: 'verified',
  merged: 'merged',
  failed: 'failed',
  conflict: 'conflict',
  cancelled: 'cancelled',
  planning: 'planning',
  review: 'review',
}

/**
 * A task's state as a dot. The state is also named in text (title and
 * accessible name), so colour is never the only signal.
 */
export function StatusDot({
  dot,
  className,
}: {
  dot: CampaignDot
  className?: string
}) {
  const { t } = useTranslation()
  const label = t(`settings:campaigns.board.dot.${KEY[dot]}`)
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-dot={dot}
      className={cn('inline-block size-2 shrink-0 rounded-full', COLOR[dot], className)}
    />
  )
}
