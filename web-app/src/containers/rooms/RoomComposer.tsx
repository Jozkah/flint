import { useId, useRef, useState, type ReactNode } from 'react'
import { ClearRoomDialog } from './ClearRoomDialog'
import type { ClearScope } from '@/lib/rooms/clearRoom'
import { ArrowUp, AtSign } from 'lucide-react'
import type { Address, Room } from '@/lib/rooms/types'
import { ROOM_LIMIT_CEILINGS } from '@/lib/rooms/types'
import { checkLimits } from '@/lib/rooms/limits'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { normalizeError, useRoomsApi, type RoomsUiError } from './roomsBindings'
import { activeParticipants, participantColor } from './roomUi'
import { selectClassName } from './RoomModelSelect'
import { RoomAvatar } from './RoomAvatar'
import { SlashCommandMenu } from '@/components/SlashCommandMenu'
import { slashOptionId } from '@/lib/slashCommands'
import { useSlashCommands } from '@/hooks/useSlashCommands'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'

const toValue = (a: Address) =>
  a.kind === 'participant' ? `participant:${a.participantId}` : a.kind

function fromValue(value: string): Address {
  if (value.startsWith('participant:')) {
    return { kind: 'participant', participantId: value.slice('participant:'.length) }
  }
  return value === 'moderator' ? { kind: 'moderator' } : { kind: 'room' }
}

export function RoomComposer({ room }: { room: Room }) {
  const { t } = useTranslation()
  const api = useRoomsApi()
  const id = useId()
  const spellCheckChatInput = useGeneralSetting((s) => s.spellCheckChatInput)
  const [text, setText] = useState('')
  const [to, setTo] = useState('room')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<RoomsUiError | null>(null)
  const [extendBy, setExtendBy] = useState(3)
  const textRef = useRef<HTMLTextAreaElement>(null)
  // The same `/` commands as the other composers, filtered for Rooms; a
  // command expands into the message the room receives.
  const [clearOpen, setClearOpen] = useState(false)
  const slash = useSlashCommands({
    surface: 'rooms',
    helpDescription: t('slash:builtin.help'),
    builtins: [
      {
        name: 'clear',
        description: t('rooms:clear.command'),
        run: () => setClearOpen(true),
      },
    ],
  })
  const clear = async (scope: ClearScope) => {
    setClearOpen(false)
    setError(null)
    try {
      await api.controller.clearRoom(room.id, scope)
    } catch (err) {
      setError(normalizeError(err))
    }
  }
  const changeText = (value: string) => {
    setText(value)
    slash.onTextChange(value)
  }

  /** The message the room gets for a draft, or null when nothing is sent. */
  const expand = async (body: string): Promise<string | null> => {
    const result = await slash.prepareSend(body)
    if (result.kind === 'handled') {
      setText('')
      return null
    }
    if (result.kind === 'error') {
      setError({ message: t('slash:error', { command: body.split(/\s/)[0], error: result.error }) })
      return null
    }
    return result.kind === 'message' ? result.text : body
  }

  // The room is not running and continuing would immediately hit a soft limit
  // (whether it stopped on that limit or concluded while already at it). A plain
  // message would only re-trip it, so offer to raise that limit and continue.
  // The hard 'ceiling' is not extendable.
  const blocking =
    room.status === 'running'
      ? null
      : checkLimits(room, Date.now(), { activeSince: Date.now(), callsMade: 0, speaking: true })
  // Any soft limit blocks; 'ceiling' is the hard cap and cannot be extended.
  const limitStop = blocking && blocking !== 'ceiling' ? blocking : null
  // Continue is measured in rounds regardless of which limit was hit.
  const limitCeiling = ROOM_LIMIT_CEILINGS.maxRounds

  const send = async () => {
    const typed = text.trim()
    if (!typed || sending) return
    setSending(true)
    setError(null)
    try {
      const body = await expand(typed)
      if (body === null) return
      await api.controller.sendUserMessage(room.id, body, fromValue(to))
      setText('')
    } catch (err) {
      setError(normalizeError(err))
    } finally {
      setSending(false)
    }
  }

  const extend = async () => {
    if (sending) return
    setSending(true)
    setError(null)
    try {
      const typed = text.trim()
      const body = typed ? await expand(typed) : ''
      if (body === null) return
      await api.controller.extendLimit(
        room.id,
        extendBy,
        body || undefined,
        body ? fromValue(to) : undefined
      )
      setText('')
    } catch (err) {
      setError(normalizeError(err))
    } finally {
      setSending(false)
    }
  }

  const targets: Array<{ value: string; label: string; avatar?: ReactNode }> = [
    { value: toValue({ kind: 'room' }), label: t('rooms:composer.toRoom') },
    ...(room.moderator.enabled
      ? [
          {
            value: toValue({ kind: 'moderator' }),
            label: room.moderator.name || t('rooms:composer.toModerator'),
          },
        ]
      : []),
    ...activeParticipants(room).map((p) => ({
      value: toValue({ kind: 'participant', participantId: p.id }),
      label: p.name,
      avatar: <RoomAvatar model={p.model} name={p.name} color={participantColor(p.id)} size={16} />,
    })),
  ]
  const current = targets.find((x) => x.value === to) ?? targets[0]
  const placeholder = limitStop
    ? t('rooms:composer.placeholderExtend')
    : current.value === 'room'
      ? t('rooms:composer.placeholder')
      : t('rooms:composer.placeholderTo', { name: current.label })
  const ready = text.trim().length > 0 && !sending

  // Arrow keys move between the address chips, as in any radio group.
  const moveTarget = (step: number) => {
    const i = Math.max(0, targets.findIndex((x) => x.value === current.value))
    const next = targets[(i + step + targets.length) % targets.length]
    setTo(next.value)
    document.getElementById(`${id}-to-${next.value}`)?.focus()
  }

  const mention = () => {
    setText((v) => v + (v && !v.endsWith(' ') ? ' @' : '@'))
    textRef.current?.focus()
  }

  return (
    // The fade lets the transcript dissolve into the composer instead of
    // stopping at a hard edge; the composer itself sits above it.
    <div className="relative shrink-0 px-3.5 pt-2 pb-3.5 before:pointer-events-none before:absolute before:inset-x-0 before:-top-9 before:h-9 before:bg-gradient-to-b before:from-transparent before:to-card">
      <ClearRoomDialog
        open={clearOpen}
        running={room.status === 'running'}
        onCancel={() => setClearOpen(false)}
        onClear={(scope) => void clear(scope)}
      />
      <form
        className="relative z-10 mx-auto flex w-full max-w-[780px] flex-col rounded-xl border-[0.8px] border-border bg-card shadow-[0_4px_14px_rgba(0,0,0,.04)] transition-[border-color,box-shadow,transform] duration-300 ease-expo focus-within:border-border-strong focus-within:shadow-[0_0_0_3px_rgba(156,163,175,.18),0_12px_30px_-12px_rgba(0,0,0,.25)] motion-safe:focus-within:-translate-y-0.5"
        onSubmit={(e) => {
          e.preventDefault()
          void (limitStop ? extend() : send())
        }}
      >
        {limitStop && (
          <p
            className="mx-2.5 mt-2.5 rounded-lg bg-warning-tint px-2.5 py-1.5 text-xs text-warning"
            data-testid="room-limit-notice"
          >
            {t('rooms:composer.limitReached', { limit: t(`rooms:limits.${limitStop}`) })}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2 text-xs">
          <span aria-hidden className="text-muted-foreground">
            {t('rooms:composer.toShort')}
          </span>
          <div
            role="radiogroup"
            aria-label={t('rooms:composer.to')}
            className="flex flex-wrap items-center gap-1.5"
          >
            {targets.map((x) => {
              const on = x.value === current.value
              return (
                <button
                  key={x.value}
                  id={`${id}-to-${x.value}`}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setTo(x.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                      e.preventDefault()
                      moveTarget(1)
                    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                      e.preventDefault()
                      moveTarget(-1)
                    }
                  }}
                  className={cn(
                    'inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-full border-[0.8px] pr-2.5 pl-[5px] text-xs outline-hidden transition-[background-color,border-color,color,transform] duration-150 ease-expo focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.965]',
                    on
                      ? 'border-transparent bg-grad text-on-grad'
                      : 'border-border bg-card text-secondary-foreground hover:border-border-strong'
                  )}
                >
                  {x.avatar ?? <AtSign aria-hidden className="ml-0.5 size-[13px]" />}
                  <span className="max-w-32 truncate">{x.label}</span>
                </button>
              )
            })}
          </div>
        </div>
        {slash.open && (
          <SlashCommandMenu
            items={slash.visible}
            activeIndex={slash.activeIndex}
            listId={`${id}-slash`}
            help={slash.helpOpen}
            onActiveChange={slash.setActiveIndex}
            onSelect={(item) => changeText(slash.pick(item))}
          />
        )}
        <label htmlFor={`${id}-text`} className="sr-only">
          {t('rooms:composer.label')}
        </label>
        <textarea
          spellCheck={spellCheckChatInput}
          id={`${id}-text`}
          ref={textRef}
          value={text}
          aria-autocomplete="list"
          aria-controls={slash.open ? `${id}-slash` : undefined}
          aria-activedescendant={
            slash.open && slash.visible.length > 0
              ? slashOptionId(`${id}-slash`, slash.activeIndex)
              : undefined
          }
          rows={2}
          maxLength={ROOM_LIMIT_CEILINGS.maxTextLength}
          placeholder={placeholder}
          aria-describedby={`${id}-hint`}
          onChange={(e) => changeText(e.target.value)}
          onKeyDown={(e) => {
            const slashKey = slash.onKeyDown(e)
            if (typeof slashKey === 'string') {
              changeText(slashKey)
              return
            }
            if (slashKey) return
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void (limitStop ? extend() : send())
            }
          }}
          className="block min-h-12 w-full resize-none border-0 bg-transparent px-3 pt-2.5 pb-1 text-base leading-normal text-foreground outline-hidden placeholder:text-muted-foreground md:text-[13px]"
        />
        <div className="flex items-center justify-between gap-2 p-2">
          <button
            type="button"
            aria-label={t('rooms:composer.mention')}
            title={t('rooms:composer.mention')}
            onClick={mention}
            className="grid size-7 cursor-pointer place-items-center rounded-[7px] text-secondary-foreground outline-hidden transition-[background-color,color,transform] duration-150 ease-expo hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.965] [&_svg]:size-[15px]"
          >
            <AtSign aria-hidden />
          </button>
          <div className="flex min-w-0 items-center gap-2">
            <span id={`${id}-hint`} className="hidden text-[11.5px] text-subtle-foreground sm:inline">
              {t('rooms:composer.hint')}
            </span>
            {limitStop ? (
              <>
                <label htmlFor={`${id}-extend`} className="text-xs text-muted-foreground">
                  {t('rooms:composer.extendBy')}
                </label>
                <input
                  id={`${id}-extend`}
                  type="number"
                  min={1}
                  max={limitCeiling}
                  value={extendBy}
                  onChange={(e) => setExtendBy(Math.max(1, Number(e.target.value) || 1))}
                  className={`${selectClassName} h-7 w-16 tabular-nums`}
                />
                <Button type="submit" size="sm" disabled={sending}>
                  {t('rooms:composer.continue')}
                </Button>
              </>
            ) : (
              <button
                type="submit"
                aria-label={t('rooms:composer.send')}
                disabled={!ready}
                data-ready={ready || undefined}
                className="grid size-7 cursor-pointer place-items-center rounded-lg border border-primary bg-grad text-on-grad outline-hidden transition-[transform,opacity,filter,box-shadow] duration-250 ease-expo hover:brightness-110 focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-95 disabled:cursor-default disabled:opacity-55 data-ready:shadow-[0_4px_14px_-4px_rgba(0,0,0,.35)] motion-safe:data-ready:animate-send-ready dark:border-white/80"
              >
                <ArrowUp aria-hidden className="size-3.5" strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
        {error && (
          <p role="alert" className="px-3 pb-2.5 text-xs text-destructive">
            {error.message}
          </p>
        )}
      </form>
    </div>
  )
}
