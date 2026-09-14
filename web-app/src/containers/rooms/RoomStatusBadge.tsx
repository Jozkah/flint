import type { RoomStatus } from '@/lib/rooms/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { WorkStatus, type WorkState } from '@/containers/StatusChip'

// A room's state as work status: icon and word, and never the accent, which
// marks selection and the primary action rather than activity.
const STATE: Record<RoomStatus, WorkState> = {
  draft: 'queued',
  running: 'running',
  'awaiting-user': 'needs-you',
  paused: 'waiting',
  stopped: 'cancelled',
  completed: 'done',
  failed: 'failed',
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
    <WorkStatus
      state={STATE[status]}
      data-testid="room-status"
      data-status={status}
      className={className}
    >
      {t(`rooms:status.${status}`)}
    </WorkStatus>
  )
}
