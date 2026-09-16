import { useId, useState } from 'react'
import type { Address, Room } from '@/lib/rooms/types'
import { ROOM_LIMIT_CEILINGS } from '@/lib/rooms/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { normalizeError, useRoomsApi, type RoomsUiError } from './roomsBindings'
import { activeParticipants } from './roomUi'
import { selectClassName } from './RoomModelSelect'

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

  // The room stopped because a soft limit was reached. A plain message would
  // only re-trip it, so offer to raise that limit and continue. The hard
  // 'ceiling' is not extendable.
  const limitStop =
    room.status === 'stopped' &&
    room.stopReason?.kind === 'limit' &&
    room.stopReason.limit !== 'ceiling'
      ? room.stopReason.limit
      : null
  const limitCeiling = limitStop ? ROOM_LIMIT_CEILINGS[limitStop] : undefined

  const send = async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    setError(null)
    try {
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
      const body = text.trim()
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
      <Textarea
        id={`${id}-text`}
        value={text}
        rows={2}
        maxLength={ROOM_LIMIT_CEILINGS.maxTextLength}
        placeholder={t(limitStop ? 'rooms:composer.placeholderExtend' : 'rooms:composer.placeholder')}
        aria-describedby={`${id}-hint`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void (limitStop ? extend() : send())
          }
        }}
      />
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
