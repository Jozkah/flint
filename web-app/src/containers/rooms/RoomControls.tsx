import { useId, useState, type ReactNode } from 'react'
import {
  ChevronRight,
  CircleCheck,
  FileText,
  Flag,
  MessagesSquare,
  Pause,
  Play,
  ShieldAlert,
  SkipForward,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import type { LiveTurn, Participant, Room } from '@/lib/rooms/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { normalizeError, useRoomsApi, useRoomsState, type RoomsUiError } from './roomsBindings'
import {
  activeParticipants,
  availableParticipants,
  controlAvailability,
  findParticipant,
  participantColor,
} from './roomUi'
import { RoomAvatar } from './RoomAvatar'
import { findModel } from './RoomModelSelect'
import { useModelProvider } from '@/hooks/useModelProvider'
import { RoomStatusBadge } from './RoomStatusBadge'
import './rooms.css'

type T = (key: string, options?: Record<string, unknown>) => string

const ACTIVE = ['running', 'awaiting-user', 'paused']

/** Who is on stage right now, in words, for the top of the panel. */
function stageFor(
  room: Room,
  live: LiveTurn | null,
  t: T,
  modelName: (p: Participant) => string
) {
  if (live && live.author.kind !== 'system') {
    const p =
      live.author.kind === 'participant'
        ? findParticipant(room, live.author.participantId)
        : undefined
    const name =
      live.author.kind === 'user'
        ? t('rooms:transcript.you')
        : live.author.name || p?.name || t('rooms:transcript.moderator')
    return {
      title: t(live.compacting ? 'rooms:stage.compacting' : 'rooms:stage.speaking', { name }),
      hint: p ? [p.role.trim(), modelName(p)].filter(Boolean).join(' · ') : '',
      speaker: p,
      speakerName: name,
    }
  }
  const count = activeParticipants(room).length
  const hint: Record<Room['status'], string> = {
    draft: t('rooms:stage.draftHint', { count, mode: t(`rooms:mode.${room.mode}`) }),
    running: t('rooms:stage.runningHint'),
    'awaiting-user': t('rooms:stage.awaitingHint'),
    paused: t('rooms:stage.pausedHint'),
    stopped: t('rooms:stage.stoppedHint'),
    completed: t('rooms:stage.completedHint'),
    failed: t('rooms:stage.failedHint'),
  }
  return {
    title: t(`rooms:stage.${room.status}`),
    hint: hint[room.status],
    speaker: undefined,
    speakerName: '',
  }
}

/**
 * The speaking order from here: the chosen next speaker first, then whoever
 * has not spoken this round, then the rest, and whoever is speaking right now
 * last, so "Up next" reads left to right.
 */
function speakingQueue(room: Room, speakingId: string | null): Participant[] {
  const all = activeParticipants(room)
  if (!ACTIVE.includes(room.status)) return all
  const later = (p: Participant) =>
    p.id === speakingId ? 2 : room.spokenThisRound.includes(p.id) ? 1 : 0
  const next = all.filter((p) => p.id === room.nextSpeakerId && p.id !== speakingId)
  const rest = all.filter((p) => !next.includes(p))
  return [...next, ...rest.sort((a, b) => later(a) - later(b))]
}

const sectionHeading =
  'text-[11px] font-medium uppercase tracking-[.025em] text-subtle-foreground'

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
        'flex h-[42px] cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[10px] border-[0.8px] border-border bg-card text-[11px] font-medium text-secondary-foreground outline-hidden transition-[transform,background-color,border-color,color] duration-150 ease-expo hover:border-border-strong hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.965] disabled:pointer-events-none disabled:opacity-45 data-[state=open]:border-border-strong [&_svg]:size-3.5',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}

/** A "steer the discussion" tile: icon, name and one line on what it does. */
function ActionTile({
  icon,
  label,
  hint,
  ...props
}: Omit<React.ComponentProps<'button'>, 'children'> & {
  icon: ReactNode
  label: string
  hint: string
}) {
  const id = useId()
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={`${id}-hint`}
      className="flex cursor-pointer flex-col items-start gap-1 rounded-[10px] border-[0.8px] border-border bg-card p-2.5 text-left outline-hidden transition-[transform,box-shadow,border-color] duration-250 ease-expo hover:-translate-y-px hover:shadow-lift focus-visible:ring-[3px] focus-visible:ring-ring/40 aria-expanded:border-border-strong disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none"
      {...props}
    >
      <span className="mb-0.5 grid size-[26px] place-items-center rounded-lg bg-muted text-secondary-foreground shadow-[inset_0_0_0_0.8px_var(--border)] [&_svg]:size-3.5">
        {icon}
      </span>
      <b className="text-[12.5px] font-semibold text-foreground">{label}</b>
      <small id={`${id}-hint`} className="text-[11.5px] leading-[1.35] text-muted-foreground">
        {hint}
      </small>
    </button>
  )
}

export function RoomControls({ room }: { room: Room }) {
  const { t } = useTranslation()
  const api = useRoomsApi()
  const providers = useModelProvider((s) => s.providers)
  const { liveTurn, pendingAction, lastError } = useRoomsState()
  const [localError, setLocalError] = useState<RoomsUiError | null>(null)
  const [voteOpen, setVoteOpen] = useState(false)
  const [proposal, setProposal] = useState('')
  const [stopOpen, setStopOpen] = useState(false)
  const [running, setRunning] = useState(false)

  const avail = controlAvailability(room, liveTurn)
  const busy = running || pendingAction !== null
  const c = api.controller
  const error = localError ?? lastError
  const live = liveTurn?.roomId === room.id ? liveTurn : null
  const active = ACTIVE.includes(room.status)

  const run = async (fn: () => Promise<void>) => {
    setLocalError(null)
    setRunning(true)
    try {
      await fn()
    } catch (err) {
      setLocalError(normalizeError(err))
    } finally {
      setRunning(false)
    }
  }

  const speakers = availableParticipants(room)
  const stage = stageFor(room, live, t, (p) => {
    const m = findModel(providers, p.model)
    return m?.displayName || m?.name || p.model.id
  })
  const queue = speakingQueue(
    room,
    live?.author.kind === 'participant' ? live.author.participantId : null
  ).slice(0, 4)
  const { usage, limits } = room
  const turnShare = limits.maxTurns > 0 ? Math.min(100, (usage.turns / limits.maxTurns) * 100) : 0
  const onStage = room.status === 'running' && live !== null

  // One main button that always says the next obvious thing: start a room that
  // is not running, pause one that is, resume one that is paused.
  const main =
    room.status === 'running' || room.status === 'awaiting-user' ? (
      <Button
        className="h-[42px] rounded-[10px] text-[13px] font-semibold [&_svg]:size-4"
        disabled={!avail.pause || busy}
        onClick={() => run(() => c.pause(room.id))}
      >
        <Pause fill="currentColor" strokeWidth={0} aria-hidden />
        {t('rooms:controls.pause')}
      </Button>
    ) : room.status === 'paused' ? (
      <Button
        className="h-[42px] rounded-[10px] text-[13px] font-semibold [&_svg]:size-4"
        disabled={!avail.resume || busy}
        onClick={() => run(() => c.resume(room.id))}
      >
        <Play fill="currentColor" strokeWidth={0} aria-hidden />
        {t('rooms:controls.resume')}
      </Button>
    ) : (
      <Button
        className="h-[42px] rounded-[10px] text-[13px] font-semibold [&_svg]:size-4"
        disabled={!avail.start || busy}
        onClick={() => run(() => c.start(room.id))}
      >
        <Play fill="currentColor" strokeWidth={0} aria-hidden />
        {t('rooms:controls.start')}
      </Button>
    )

  return (
    <section
      aria-label={t('rooms:controls.label')}
      aria-busy={busy}
      className="flex min-w-0 flex-col gap-4"
    >
      <Frame className="motion-safe:animate-rise-in">
        <FrameHeader
          icon={<MessagesSquare />}
          title={t('rooms:controls.discussion')}
          actions={<RoomStatusBadge status={room.status} />}
        />
        <FrameBody className="gap-0 p-3.5">
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
                {t('rooms:stage.round')}{' '}
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
                className="block h-full rounded-full bg-grad transition-[width] duration-700 ease-expo motion-safe:animate-draw-x"
                style={{ width: `${turnShare}%` }}
              />
            </div>
          </div>

          <div className="mt-3.5 grid grid-cols-[1.6fr_1fr_1fr] gap-2">
            {main}
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
                    <DropdownMenuItem
                      key={p.id}
                      onSelect={() => run(() => c.selectNext(room.id, p.id))}
                    >
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
            <TransportButton
              className="text-destructive hover:border-destructive/40 hover:bg-destructive/8 hover:text-destructive"
              disabled={!avail.stop || busy}
              onClick={() => setStopOpen(true)}
            >
              <Square fill="currentColor" strokeWidth={0} aria-hidden />
              <span>{t('rooms:controls.stop')}</span>
            </TransportButton>
          </div>

          {queue.length > 0 ? (
            <div className="mt-3.5 flex flex-col gap-2">
              <span className={sectionHeading}>
                {t(active ? 'rooms:controls.upNext' : 'rooms:controls.order')}
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {queue.map((p, i) => {
                  const canPick =
                    avail.selectNext && !busy && p.availability.state !== 'unavailable'
                  return (
                    <span key={p.id} className="contents">
                      {i > 0 && (
                        <ChevronRight aria-hidden className="size-3 text-subtle-foreground" />
                      )}
                      <button
                        type="button"
                        disabled={!canPick}
                        aria-label={t('rooms:controls.pickNext', { name: p.name })}
                        onClick={() => run(() => c.selectNext(room.id, p.id))}
                        className={cn(
                          'inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full border-[0.8px] border-border bg-card pr-2.5 pl-1 text-xs text-secondary-foreground outline-hidden transition-[border-color,color,transform] duration-150 ease-expo hover:border-border-strong hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.965] disabled:cursor-default disabled:active:scale-100',
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
          ) : null}

          {!avail.start && room.status === 'draft' && activeParticipants(room).length < 2 && (
            <p className="mt-2.5 text-xs text-muted-foreground">
              {t('rooms:controls.needParticipants')}
            </p>
          )}
        </FrameBody>
      </Frame>

      <Frame className="motion-safe:animate-rise-in [animation-delay:50ms]">
        <FrameHeader icon={<Sparkles />} title={t('rooms:controls.steer')} />
        <FrameBody className="gap-0 p-3.5">
          <div className="grid grid-cols-2 gap-2">
            <ActionTile
              icon={<CircleCheck />}
              label={t('rooms:controls.callVote')}
              hint={t('rooms:controls.callVoteHint')}
              disabled={!avail.callVote || busy}
              aria-expanded={voteOpen}
              onClick={() => setVoteOpen((v) => !v)}
            />
            <ActionTile
              icon={<Flag />}
              label={t('rooms:controls.finalPositions')}
              hint={t('rooms:controls.finalPositionsHint')}
              disabled={!avail.requestFinalPositions || busy}
              onClick={() => run(() => c.requestFinalPositions(room.id))}
            />
            <ActionTile
              icon={<FileText />}
              label={t('rooms:controls.synthesize')}
              hint={t('rooms:controls.synthesizeHint')}
              disabled={!avail.synthesize || busy}
              onClick={() => run(() => c.synthesize(room.id))}
            />
            <ActionTile
              icon={<X />}
              label={t('rooms:controls.cancelTurn')}
              hint={t('rooms:controls.cancelTurnHint')}
              disabled={!avail.cancelTurn || busy}
              onClick={() => run(() => c.cancelTurn(room.id))}
            />
          </div>

          {voteOpen && avail.callVote && (
            <form
              className="mt-2.5 flex flex-col gap-1.5 motion-safe:animate-dd-in"
              onSubmit={(e) => {
                e.preventDefault()
                const text = proposal.trim()
                if (!text) return
                run(async () => {
                  await c.callVote(room.id, text)
                  setProposal('')
                  setVoteOpen(false)
                })
              }}
            >
              <label htmlFor={`vote-${room.id}`} className="sr-only">
                {t('rooms:controls.proposal')}
              </label>
              <Input
                id={`vote-${room.id}`}
                autoFocus
                value={proposal}
                placeholder={t('rooms:controls.proposalPlaceholder')}
                onChange={(e) => setProposal(e.target.value)}
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={!proposal.trim() || busy}>
                  {t('rooms:controls.submitVote')}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setVoteOpen(false)}>
                  {t('rooms:controls.cancel')}
                </Button>
              </div>
            </form>
          )}

          {!active && (
            <p className="mt-2.5 text-xs text-muted-foreground">{t('rooms:controls.steerLocked')}</p>
          )}
          {busy && (
            <p role="status" className="mt-2.5 text-xs text-muted-foreground">
              {t('rooms:controls.busy')}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2.5 text-xs text-destructive">
              {error.message}
            </p>
          )}
        </FrameBody>
      </Frame>

      <Dialog open={stopOpen} onOpenChange={setStopOpen}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('rooms:controls.stopTitle')}</DialogTitle>
            <DialogDescription>{t('rooms:controls.stopDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="surface" onClick={() => setStopOpen(false)}>
              {t('rooms:controls.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setStopOpen(false)
                run(() => c.stop(room.id))
              }}
            >
              {t('rooms:controls.stopConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
