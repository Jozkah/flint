import { useEffect, useMemo, useRef } from 'react'
import type { LiveTurn, Room, RoomAuthor, RoomJournalRecord, RoomMessage } from '@/lib/rooms/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  addressLabel,
  findParticipant,
  messagesOf,
  participantAttribution,
  voteTallies,
  type VoteTally,
} from './roomUi'

type T = (key: string, options?: Record<string, unknown>) => string

function authorLabel(author: RoomAuthor, room: Room | null, t: T): string {
  switch (author.kind) {
    case 'participant': {
      const p = findParticipant(room, author.participantId)
      const label = participantAttribution(p, author.name || t('rooms:transcript.unknownParticipant'))
      return p?.removed ? `${label} ${t('rooms:transcript.removed')}` : label
    }
    case 'moderator':
      return author.name
        ? t('rooms:transcript.moderatorNamed', { name: author.name })
        : t('rooms:transcript.moderator')
    case 'user':
      return t('rooms:transcript.you')
    case 'system':
      return t('rooms:transcript.system')
  }
}

/** Model output is untrusted: always plain text, whitespace preserved. */
function PlainText({ text, className }: { text: string; className?: string }) {
  return (
    <p className={cn('whitespace-pre-wrap break-words text-sm text-foreground', className)}>
      {text}
    </p>
  )
}

function Badge({ tone, children }: { tone: 'warn' | 'error' | 'info'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        tone === 'error' && 'bg-destructive/10 text-destructive',
        tone === 'warn' && 'bg-secondary text-secondary-foreground',
        tone === 'info' && 'bg-muted text-muted-foreground'
      )}
    >
      {children}
    </span>
  )
}

function KindLabel({ message, t }: { message: RoomMessage; t: T }) {
  switch (message.kind) {
    case 'vote-call':
      return <Badge tone="info">{t('rooms:transcript.voteCall')}</Badge>
    case 'vote':
      return (
        <Badge tone="info">
          {t('rooms:transcript.vote')}
          {message.vote ? `: ${t(`rooms:transcript.choice.${message.vote.choice}`)}` : ''}
        </Badge>
      )
    case 'final-position':
      return <Badge tone="info">{t('rooms:transcript.finalPosition')}</Badge>
    case 'synthesis':
      return <Badge tone="info">{t('rooms:transcript.synthesis')}</Badge>
    case 'moderator-note':
      return <Badge tone="info">{t('rooms:transcript.moderatorNote')}</Badge>
    default:
      return null
  }
}

function MessageBody({
  message,
  tally,
  t,
}: {
  message: RoomMessage
  tally: VoteTally | undefined
  t: T
}) {
  return (
    <>
      <PlainText text={message.text} />
      {message.kind === 'vote-call' && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="vote-tally">
          {t('rooms:transcript.tally', tally ?? { agree: 0, disagree: 0, abstain: 0 })}
        </p>
      )}
      {message.kind === 'moderator-note' &&
        message.directive &&
        message.directive.disagreements.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-medium text-muted-foreground">
              {t('rooms:transcript.disagreements')}
            </p>
            <ul className="ml-4 list-disc text-sm">
              {message.directive.disagreements.map((d, i) => (
                <li key={i} className="whitespace-pre-wrap break-words">
                  {d}
                </li>
              ))}
            </ul>
          </div>
        )}
      {message.kind === 'synthesis' && message.dissent && (
        <section
          aria-label={t('rooms:transcript.dissent')}
          data-testid="synthesis-dissent"
          className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3"
        >
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-destructive">
            {t('rooms:transcript.dissent')}
          </h4>
          {message.dissent.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('rooms:transcript.noDissent')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {message.dissent.map((d) => (
                <li key={d.participantId}>
                  <span className="text-xs font-medium">{d.name}</span>
                  <PlainText text={d.position} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {message.status === 'failed' && message.error && (
        <p className="mt-1 text-xs text-destructive" data-testid="message-error">
          {message.error.message}
        </p>
      )}
    </>
  )
}

type RoomTranscriptProps = {
  room: Room
  journal: RoomJournalRecord[]
  liveTurn: LiveTurn | null
}

export function RoomTranscript({ room, journal, liveTurn }: RoomTranscriptProps) {
  const { t } = useTranslation()
  const messages = useMemo(() => messagesOf(journal), [journal])
  const tallies = useMemo(() => voteTallies(messages), [messages])
  const live = liveTurn?.roomId === room.id ? liveTurn : null
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [messages.length, live?.text])

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={t('rooms:transcript.label')}
        className="flex flex-col gap-3"
      >
        {messages.length === 0 && !live && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('rooms:transcript.empty')}
          </p>
        )}
        {messages.map((m) => {
          const toUser = m.to.kind === 'user'
          const chip = addressLabel(m.to, room, t)
          if (m.kind === 'system') {
            return (
              <div
                key={m.id}
                data-testid="room-message"
                data-kind={m.kind}
                className="px-2 text-center text-xs text-muted-foreground"
              >
                <span className="sr-only">{t('rooms:transcript.system')}: </span>
                <span className="whitespace-pre-wrap break-words">{m.text}</span>
              </div>
            )
          }
          return (
            <article
              key={m.id}
              data-testid="room-message"
              data-kind={m.kind}
              data-status={m.status}
              data-addressed-to-user={toUser || undefined}
              className={cn(
                'min-w-0 rounded-lg border border-border bg-card p-3',
                m.kind === 'user' && 'bg-secondary/40',
                m.kind === 'synthesis' && 'border-foreground/30',
                toUser && 'border-l-4 border-l-primary'
              )}
            >
              <header className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="font-medium text-foreground">
                  {authorLabel(m.author, room, t)}
                </span>
                {chip && (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
                    {chip}
                  </span>
                )}
                <KindLabel message={m} t={t} />
                {m.status === 'interrupted' && (
                  <Badge tone="warn">{t('rooms:transcript.interrupted')}</Badge>
                )}
                {(m.status === 'failed' || m.kind === 'error') && (
                  <Badge tone="error">{t('rooms:transcript.failed')}</Badge>
                )}
                {toUser && (
                  <span className="font-medium text-primary">
                    {t('rooms:transcript.addressedToYou')}
                  </span>
                )}
              </header>
              <MessageBody message={m} tally={tallies.get(m.id)} t={t} />
            </article>
          )
        })}
      </div>
      {live && (
        <article
          data-testid="room-live-turn"
          aria-busy="true"
          className="min-w-0 rounded-lg border border-dashed border-border bg-card p-3"
        >
          <header className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-medium text-foreground">{authorLabel(live.author, room, t)}</span>
            <span className="text-muted-foreground motion-safe:animate-pulse">
              {t('rooms:transcript.streaming')}
            </span>
          </header>
          <PlainText text={live.text} />
        </article>
      )}
      <div ref={endRef} />
    </div>
  )
}
