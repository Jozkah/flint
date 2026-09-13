import type { RoomStatus } from '@/lib/rooms/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

const TONE: Record<RoomStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  running: 'bg-brand-fill text-foreground',
  'awaiting-user': 'bg-brand-fill text-foreground',
  paused: 'bg-secondary text-secondary-foreground',
  stopped: 'bg-muted text-muted-foreground',
  completed: 'bg-secondary text-secondary-foreground',
  failed: 'bg-destructive/10 text-destructive',
}

export function RoomStatusBadge({
  status,
  className,
}: {
  status: RoomStatus
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <span
      data-testid="room-status"
      data-status={status}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
        TONE[status],
        className
      )}
    >
      {t(`rooms:status.${status}`)}
    </span>
  )
}
