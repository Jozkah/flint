import { ChevronRight } from 'lucide-react'
import type { Participant } from '@/lib/rooms/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { RoomAvatar } from '../RoomAvatar'
import { participantColor } from '../roomUi'

const sectionHeading =
  'text-[length:calc(var(--ui-font-base)*0.6875)] font-medium uppercase tracking-[.025em] text-subtle-foreground'

type Props = {
  queue: Participant[]
  /** A compare room: everyone answers at once, so no order and no picking. */
  compare: boolean
  /** The room is under way. */
  active: boolean
  /** Next speaker may be chosen now (and nothing is in flight). */
  canSelect: boolean
  onPick: (participantId: string) => void
}

/** "Up next" (or who is answering), each chip a shortcut to speak next. */
export function SpeakingQueue({
  queue,
  compare,
  active,
  canSelect,
  onPick,
}: Props): React.ReactElement | null {
  const { t } = useTranslation()
  if (queue.length === 0) return null
  return (
    <div className="mt-3.5 flex flex-col gap-2">
      <span className={sectionHeading}>
        {t(
          compare
            ? active
              ? 'rooms:controls.answering'
              : 'rooms:controls.models'
            : active
              ? 'rooms:controls.upNext'
              : 'rooms:controls.order'
        )}
      </span>
      <div className="flex flex-wrap items-center gap-1">
        {queue.map((p, i) => {
          const canPick = !compare && canSelect && p.availability.state !== 'unavailable'
          return (
            <span key={p.id} className="contents">
              {i > 0 && !compare && (
                <ChevronRight aria-hidden className="size-3 text-subtle-foreground" />
              )}
              <button
                type="button"
                disabled={!canPick}
                aria-label={compare ? p.name : t('rooms:controls.pickNext', { name: p.name })}
                onClick={() => onPick(p.id)}
                className={cn(
                  'inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full border-[0.8px] border-border bg-card pr-2.5 pl-1 text-xs text-secondary-foreground outline-hidden transition-[border-color,color,transform] duration-150 ease-expo hover:border-border-strong hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.96] disabled:cursor-default disabled:active:scale-100',
                  active &&
                    i === 0 &&
                    'border-[color-mix(in_oklab,var(--primary)_45%,var(--border))] font-medium text-foreground',
                  !active && 'disabled:hover:border-border disabled:hover:text-secondary-foreground'
                )}
              >
                <RoomAvatar
                  model={p.model}
                  name={p.name}
                  color={participantColor(p.id)}
                  size={22}
                />
                <span className="max-w-24 truncate">{p.name}</span>
              </button>
            </span>
          )
        })}
      </div>
    </div>
  )
}
