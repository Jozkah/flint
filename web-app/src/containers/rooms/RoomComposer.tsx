import { useId, useState } from 'react'
import type { Address, Room } from '@/lib/rooms/types'
import { ROOM_LIMIT_CEILINGS } from '@/lib/rooms/types'
import { checkLimits } from '@/lib/rooms/limits'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { normalizeError, useRoomsApi, type RoomsUiError } from './roomsBindings'
import { activeParticipants } from './roomUi'
import { selectClassName } from './RoomModelSelect'
import { SlashCommandMenu } from '@/components/SlashCommandMenu'
import { slashOptionId } from '@/lib/slashCommands'
import { useSlashCommands } from '@/hooks/useSlashCommands'

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
  const [text, setText] = useState('')
  const [to, setTo] = useState('room')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<RoomsUiError | null>(null)
  const [extendBy, setExtendBy] = useState(3)
  // The same `/` commands as the other composers, filtered for Rooms; a
  // command expands into the message the room receives.
  const slash = useSlashCommands({
    surface: 'rooms',
    helpDescription: t('slash:builtin.help'),
  })
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

  return (
    <form
      className="flex flex-col gap-2 border-t border-border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void (limitStop ? extend() : send())
      }}
    >
      {limitStop && (
        <p className="text-xs text-muted-foreground" data-testid="room-limit-notice">
          {t('rooms:composer.limitReached', { limit: t(`rooms:limits.${limitStop}`) })}
        </p>
      )}
      <label htmlFor={`${id}-text`} className="sr-only">
        {t('rooms:composer.label')}
      </label>
      <div className="relative">
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
      <Textarea
        id={`${id}-text`}
        value={text}
        aria-autocomplete="list"
        aria-expanded={slash.open}
        aria-controls={slash.open ? `${id}-slash` : undefined}
        aria-activedescendant={
          slash.open && slash.visible.length > 0
            ? slashOptionId(`${id}-slash`, slash.activeIndex)
            : undefined
        }
        rows={2}
        maxLength={ROOM_LIMIT_CEILINGS.maxTextLength}
        placeholder={t(limitStop ? 'rooms:composer.placeholderExtend' : 'rooms:composer.placeholder')}
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
      />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-to`} className="text-xs text-muted-foreground">
          {t('rooms:composer.to')}
        </label>
        <select
          id={`${id}-to`}
          className={`${selectClassName} h-8 w-auto max-w-[14rem]`}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        >
          <option value={toValue({ kind: 'room' })}>{t('rooms:composer.toRoom')}</option>
          {room.moderator.enabled && (
            <option value={toValue({ kind: 'moderator' })}>
              {room.moderator.name || t('rooms:composer.toModerator')}
            </option>
          )}
          {activeParticipants(room).map((p) => (
            <option key={p.id} value={toValue({ kind: 'participant', participantId: p.id })}>
              {p.name}
            </option>
          ))}
        </select>
        <span id={`${id}-hint`} className="hidden text-xs text-muted-foreground sm:inline">
          {t('rooms:composer.hint')}
        </span>
        {limitStop ? (
          <div className="ml-auto flex items-center gap-2">
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
              className={`${selectClassName} h-8 w-16`}
            />
            <Button type="submit" size="sm" disabled={sending}>
              {t('rooms:composer.continue')}
            </Button>
          </div>
        ) : (
          <Button type="submit" size="sm" className="ml-auto" disabled={!text.trim() || sending}>
            {t('rooms:composer.send')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      )}
    </form>
  )
}
