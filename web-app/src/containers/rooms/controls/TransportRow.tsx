import { Pause, Play, SkipForward, Square } from 'lucide-react'
import type { Participant, Room } from '@/lib/rooms/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RoomAvatar } from '../RoomAvatar'
import { participantColor, type controlAvailability } from '../roomUi'

/** One of the two quiet transport buttons: icon over a short word. */
function TransportButton({
  className,
  children,
  ...props
}: React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-[42px] cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[10px] border-[0.8px] border-border bg-card text-[length:calc(var(--ui-font-base)*0.6875)] font-medium text-secondary-foreground outline-hidden transition-[transform,background-color,border-color,color] duration-150 ease-expo hover:border-border-strong hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.96] disabled:pointer-events-none disabled:opacity-45 data-[state=open]:border-border-strong [&_svg]:size-3.5',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}

const MAIN_BUTTON =
  'h-[42px] rounded-[10px] text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold [&_svg]:size-4'

type Props = {
  room: Room
  avail: ReturnType<typeof controlAvailability>
  busy: boolean
  /** Who may be picked to speak next. */
  speakers: Participant[]
  onPause: () => void
  onResume: () => void
  onStart: () => void
  onSelectNext: (participantId: string) => void
  onStop: () => void
}

/**
 * Start/pause/resume, Next and Stop. The main button always says the next
 * obvious thing: start a room that is not running, pause one that is, resume
 * one that is paused. A compare room answers everyone at once, so it has no
 * Next.
 */
export function TransportRow({
  room,
  avail,
  busy,
  speakers,
  onPause,
  onResume,
  onStart,
  onSelectNext,
  onStop,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const compare = room.mode === 'compare'
  const main =
    room.status === 'running' || room.status === 'awaiting-user' ? (
      <Button className={MAIN_BUTTON} disabled={!avail.pause || busy} onClick={onPause}>
        <Pause fill="currentColor" strokeWidth={0} aria-hidden />
        {t('rooms:controls.pause')}
      </Button>
    ) : room.status === 'paused' ? (
      <Button className={MAIN_BUTTON} disabled={!avail.resume || busy} onClick={onResume}>
        <Play fill="currentColor" strokeWidth={0} aria-hidden />
        {t('rooms:controls.resume')}
      </Button>
    ) : (
      <Button className={MAIN_BUTTON} disabled={!avail.start || busy} onClick={onStart}>
        <Play fill="currentColor" strokeWidth={0} aria-hidden />
        {t('rooms:controls.start')}
      </Button>
    )

  return (
    <div
      className={cn(
        'mt-3.5 grid gap-2',
        compare ? 'grid-cols-[1.6fr_1fr]' : 'grid-cols-[1.6fr_1fr_1fr]'
      )}
    >
      {main}
      {!compare && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TransportButton
              aria-label={t('rooms:controls.selectNext')}
              disabled={!avail.selectNext || busy}
            >
              <SkipForward fill="currentColor" aria-hidden />
              <span>{t('rooms:controls.next')}</span>
            </TransportButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuLabel>{t('rooms:controls.whoNext')}</DropdownMenuLabel>
            {speakers.length === 0 ? (
              <DropdownMenuItem disabled>{t('rooms:controls.noSpeakers')}</DropdownMenuItem>
            ) : (
              speakers.map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => onSelectNext(p.id)}>
                  <RoomAvatar
                    model={p.model}
                    name={p.name}
                    color={participantColor(p.id)}
                    size={16}
                  />
                  {p.role ? `${p.name} · ${p.role}` : p.name}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <TransportButton
        className="text-destructive hover:border-destructive/40 hover:bg-destructive/8 hover:text-destructive"
        disabled={!avail.stop || busy}
        onClick={onStop}
      >
        <Square fill="currentColor" strokeWidth={0} aria-hidden />
        <span>{t('rooms:controls.stop')}</span>
      </TransportButton>
    </div>
  )
}
