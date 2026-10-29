import { CircleCheck, Pause, Play, ShieldAlert } from 'lucide-react'
import type { Room } from '@/lib/rooms/types'
import { isCompareRoom } from '@/lib/rooms/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { RoomAvatar } from '../RoomAvatar'
import { participantColor } from '../roomUi'
import type { Stage } from '../roomStage'

type Props = {
  room: Room
  stage: Stage
  /** A turn is being spoken right now in a running room. */
  onStage: boolean
}

/** Who has the floor (or what the room is waiting on), and how far it has run. */
export function StageCard({ room, stage, onStage }: Props): React.ReactElement {
  const { t } = useTranslation()
  const { usage, limits } = room
  const turnShare = limits.maxTurns > 0 ? Math.min(100, (usage.turns / limits.maxTurns) * 100) : 0
  return (
    <>
      <div
        data-live={onStage || undefined}
        className={cn(
          'flex items-center gap-3 rounded-xl bg-muted p-3 shadow-[inset_0_0_0_0.8px_var(--border)]',
          onStage &&
            'shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_35%,var(--border))]'
        )}
      >
        {stage.speaker ? (
          <RoomAvatar
            model={stage.speaker.model}
            name={stage.speaker.name}
            color={participantColor(stage.speaker.id)}
            size={38}
          />
        ) : (
          <span
            aria-hidden
            className="grid size-[38px] shrink-0 place-items-center rounded-full bg-card text-muted-foreground shadow-[inset_0_0_0_0.8px_var(--border)] [&_svg]:size-4"
          >
            {room.status === 'awaiting-user' ? (
              <ShieldAlert />
            ) : room.status === 'paused' ? (
              <Pause />
            ) : room.status === 'completed' ? (
              <CircleCheck />
            ) : (
              <Play />
            )}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <b className="truncate text-sm font-semibold text-foreground">{stage.title}</b>
          {stage.hint && (
            <small className="truncate text-xs text-muted-foreground">{stage.hint}</small>
          )}
        </div>
        {onStage && (
          <span aria-hidden className="room-eq flex h-4 items-end gap-0.5">
            <i />
            <i />
            <i />
            <i />
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>
            {t(isCompareRoom(room) ? 'rooms:stage.question' : 'rooms:stage.round')}{' '}
            <b className="font-semibold text-foreground">{usage.rounds}</b>{' '}
            {t('rooms:stage.of')} {limits.maxRounds}
          </span>
          <span>
            {t('rooms:stage.turn')}{' '}
            <b className="font-semibold text-foreground">{usage.turns}</b>{' '}
            {t('rooms:stage.of')} {limits.maxTurns}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-track">
          <i
            className="block h-full rounded-full bg-grad transition-[width] duration-(--duration-very-slow) ease-expo motion-safe:animate-draw-x"
            style={{ width: `${turnShare}%` }}
          />
        </div>
      </div>
    </>
  )
}
