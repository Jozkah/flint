import { Link } from '@tanstack/react-router'
import { MoreHorizontal, Pause, Play, Trash2, ArrowUpRight } from 'lucide-react'
import type { Room, RoomMessage, RoomSummary } from '@/lib/rooms/types'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { Chip } from '@/components/ui/chip'
import { Icon } from '@/components/ui/icon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RoomAvatar } from './RoomAvatar'
import { RoomStatusBadge } from './RoomStatusBadge'
import {
  activeParticipants,
  findParticipant,
  formatCompact,
  lastSaid,
  participantColor,
  plainPreview as plain,
  timeAgo,
  type RoomDetail,
} from './roomUi'

type T = (key: string, options?: Record<string, unknown>) => string

function speakerOf(m: RoomMessage, room: Room, t: T) {
  switch (m.author.kind) {
    case 'participant': {
      const p = findParticipant(room, m.author.participantId)
      return {
        name: p?.name || m.author.name,
        color: participantColor(m.author.participantId),
        model: p?.model,
      }
    }
    case 'moderator':
      return { name: m.author.name || t('rooms:transcript.moderator'), color: undefined, model: null }
    case 'user':
      return { name: t('rooms:transcript.you'), color: undefined, model: null }
    default:
      return { name: t('rooms:transcript.system'), color: undefined, model: null }
  }
}

/** Stacked participant logos; every name is in the tooltip. */
export function AvatarStack({ room, size = 24, max = 5 }: { room: Room; size?: number; max?: number }) {
  const people = activeParticipants(room)
  if (people.length === 0) return null
  const shown = people.slice(0, max)
  return (
    <span className="flex items-center" title={people.map((p) => `${p.name} · ${p.model.id}`).join('\n')}>
      {shown.map((p, i) => (
        <RoomAvatar
          key={p.id}
          model={p.model}
          name={p.name}
          color={participantColor(p.id)}
          size={size}
          className={cn('ring-2 ring-card', i > 0 && '-ml-2')}
        />
      ))}
      {people.length > max && (
        <span className="-ml-2 grid h-6 min-w-6 place-items-center rounded-full bg-accent px-1 text-[10.5px] font-medium text-muted-foreground ring-2 ring-card">
          +{people.length - max}
        </span>
      )}
    </span>
  )
}

export function RoomCard({
  summary,
  detail,
  index,
  onDelete,
  onPause,
  onResume,
  onStart,
  onOpen,
}: {
  summary: RoomSummary
  detail?: RoomDetail
  index: number
  onDelete: () => void
  onPause: () => void
  onResume: () => void
  onStart: () => void
  onOpen: () => void
}) {
  const { t, i18n } = useTranslation()
  const lang = (i18n as { language?: string } | undefined)?.language || 'en'
  const name = summary.title || t('rooms:list.untitled')
  const room = detail?.room
  const people = room ? activeParticipants(room) : []
  const last = detail ? lastSaid(detail.journal) : null
  const speaker = last && room ? speakerOf(last, room, t) : null
  const maxTurns = room?.limits.maxTurns ?? 0
  const share = maxTurns > 0 ? Math.min(100, (summary.turns / maxTurns) * 100) : 0
  const s = summary.status
  const canPause = s === 'running' || s === 'awaiting-user'
  const canResume = s === 'paused'
  const canStart =
    (s === 'draft' || s === 'stopped' || s === 'completed' || s === 'failed') && people.length >= 2
  const tokens = room ? room.usage.inputTokens + room.usage.outputTokens : 0

  return (
    <li
      data-testid="room-summary"
      data-status={s}
      style={{ animationDelay: `${120 + Math.min(index, 8) * 50}ms` }}
      className="group/room relative flex min-w-0 flex-col gap-3 rounded-xl border-[0.8px] border-border bg-card p-4 transition-[box-shadow,transform,border-color] duration-300 ease-expo focus-within:shadow-lift hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift motion-safe:animate-rise-in"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {/* The title link covers the whole card, so anywhere on it opens the
              room; the menu sits above that overlay. */}
          <Link
            to={route.roomDetail}
            params={{ roomId: summary.id }}
            aria-label={t('rooms:list.open', { title: name })}
            className="min-w-0 truncate text-[15px] leading-tight font-semibold text-foreground outline-hidden after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/40"
          >
            {name}
          </Link>
          <div className="flex flex-wrap items-center gap-1.5">
            <RoomStatusBadge status={s} />
            <Chip className="text-muted-foreground">{t(`rooms:mode.${summary.mode}`)}</Chip>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('rooms:list.moreLabel', { title: name })}
              className="relative z-10 -mt-1 -mr-1.5 grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted-foreground outline-hidden transition-[background-color,color,transform] duration-150 ease-expo hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.965] data-[state=open]:bg-accent pointer-coarse:size-11"
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem onSelect={onOpen}>
              <ArrowUpRight aria-hidden />
              {t('rooms:list.openRoom')}
            </DropdownMenuItem>
            {canPause && (
              <DropdownMenuItem onSelect={onPause}>
                <Pause aria-hidden />
                {t('rooms:controls.pause')}
              </DropdownMenuItem>
            )}
            {canResume && (
              <DropdownMenuItem onSelect={onResume}>
                <Play aria-hidden />
                {t('rooms:controls.resume')}
              </DropdownMenuItem>
            )}
            {canStart && (
              <DropdownMenuItem onSelect={onStart}>
                <Play aria-hidden />
                {t('rooms:controls.start')}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 aria-hidden />
              {t('rooms:list.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {summary.objective && (
        <p className="line-clamp-2 min-h-[2lh] text-[13px] leading-normal text-muted-foreground">
          {summary.objective}
        </p>
      )}

      <div className="flex min-w-0 items-center gap-2.5">
        {room && people.length > 0 ? (
          <>
            <AvatarStack room={room} />
            <span className="min-w-0 truncate text-xs text-secondary-foreground">
              {people.map((p) => p.name).join(', ')}
            </span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            {summary.participantCount > 0
              ? t('rooms:list.participants', { count: summary.participantCount })
              : t('rooms:list.noParticipants')}
          </span>
        )}
      </div>

      {maxTurns > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
            <span>
              {t('rooms:stage.turn')}{' '}
              <b className="font-semibold text-foreground">{summary.turns}</b> {t('rooms:stage.of')}{' '}
              {maxTurns}
            </span>
            {tokens > 0 && <span>{t('rooms:list.tokens', { count: formatCompact(tokens) })}</span>}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-track">
            <i
              className="block h-full rounded-full bg-grad motion-safe:animate-draw-x"
              style={{ width: `${share}%`, animationDelay: `${200 + index * 50}ms` }}
            />
          </div>
        </div>
      )}

      <div className="mt-auto flex min-h-[54px] min-w-0 flex-col gap-1 rounded-lg bg-muted px-2.5 py-2 shadow-[inset_0_0_0_0.8px_var(--border)]">
        {last && speaker ? (
          <>
            <span className="flex min-w-0 items-center gap-1.5 text-[11.5px]">
              {speaker.model ? (
                <RoomAvatar model={speaker.model} name={speaker.name} color={speaker.color} size={16} />
              ) : (
                <Icon name="comment" size={14} />
              )}
              <b className="truncate font-semibold" style={{ color: speaker.color }}>
                {speaker.name}
              </b>
              <span className="ml-auto shrink-0 text-subtle-foreground">{timeAgo(last.createdAt, lang)}</span>
            </span>
            <p className="line-clamp-2 text-[12.5px] leading-snug text-fg-2">{plain(last.text)}</p>
          </>
        ) : (
          <p className="my-auto text-[12.5px] text-muted-foreground">
            {detail ? t('rooms:transcript.empty') : t('rooms:list.noPreview')}
          </p>
        )}
      </div>

      <p className="flex items-center gap-1.5 text-xs text-subtle-foreground">
        <Icon name="clock-01" size={13} />
        {t('rooms:list.updated', { time: timeAgo(summary.updatedAt, lang) })}
        <span aria-hidden>·</span>
        {t('rooms:list.turns', { count: summary.turns })}
      </p>
    </li>
  )
}
