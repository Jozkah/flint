import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ChevronDown, Globe, Search, Wrench } from 'lucide-react'
import { toneForTool, TONE_CLASSES } from '@/lib/semanticTone'
import { stripConclusion } from '@/lib/rooms/consensus'
import type {
  LiveTurn,
  Room,
  RoomAuthor,
  RoomJournalRecord,
  RoomMessage,
  RoomToolActivity,
} from '@/lib/rooms/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  addressLabel,
  findParticipant,
  messagesOf,
  participantAttribution,
  participantColor,
  participantColorsByName,
  voteTallies,
  type VoteTally,
} from './roomUi'
import { RoomMessageText } from './RoomMessageText'

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

/**
 * The message author in the transcript header. Each participant reads in their
 * own stable color (the same color their `@mentions` get), with the role and
 * model kept muted beside the name so the name is what the color highlights.
 */
function AuthorName({ author, room, t }: { author: RoomAuthor; room: Room | null; t: T }) {
  if (author.kind === 'participant') {
    return (
      <span className="font-semibold" style={{ color: participantColor(author.participantId) }}>
        {authorLabel(author, room, t)}
      </span>
    )
  }
  return <span className="font-medium text-foreground">{authorLabel(author, room, t)}</span>
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
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium',
        tone === 'error' && 'bg-destructive/10 text-destructive',
        tone === 'warn' && 'bg-warning-tint text-warning',
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

/** The lucide icon for a tool row, matching Cowork's choices. */
function toolIcon(name: string) {
  if (name === 'web_search') return Search
  if (name === 'web_fetch') return Globe
  return Wrench
}

/** The Cowork tone for one room tool call: kind colours it, failure outranks. */
function toneFor(c: RoomToolActivity) {
  return toneForTool({
    name: c.name,
    state: c.ok ? 'output-available' : 'output-error',
    isMcp: c.mcp,
  })
}

/** Args as label/value rows for the table view; a non-object shows as one row. */
function argRows(args: unknown): Array<[string, string]> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return Object.entries(args as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === 'string' ? v : JSON.stringify(v),
    ])
  }
  if (args === undefined) return []
  return [['', typeof args === 'string' ? args : JSON.stringify(args, null, 2)]]
}

/**
 * The tools a participant used. Simple view: one tone-coloured chip per call,
 * the same palette as the Cowork tab (built-in indigo, read cyan, write amber,
 * MCP violet, failures red). Advanced view (the Details toggle) expands each
 * call into a tidy Input table and a Result/Error block.
 */
function ToolTrace({ calls, t }: { calls: RoomToolActivity[]; t: T }) {
  const [expanded, setExpanded] = useState(false)
  const hasDetails = calls.some((c) => c.args !== undefined || Boolean(c.output))

  return (
    <div className="mb-1.5" data-testid="message-tools">
      <div className="flex flex-wrap items-center gap-1">
        {calls.map((c, i) => {
          const tone = TONE_CLASSES[toneFor(c)]
          const Icon = toolIcon(c.name)
          // Match Cowork: a neutral chip whose icon carries the tool's kind
          // colour, and a red tint only when the call failed.
          return (
            <span
              key={`${c.name}-${i}`}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
                c.ok ? 'bg-sunken text-ink-2' : 'bg-destructive-tint text-destructive'
              )}
            >
              <Icon
                className={cn('size-3 shrink-0', c.ok ? tone.icon : 'text-destructive')}
                aria-hidden
              />
              {c.name}
            </span>
          )
        })}
        {hasDetails && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            data-testid="tool-trace-toggle"
            className="inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                'size-3 shrink-0 transition-transform',
                expanded ? 'rotate-0' : '-rotate-90'
              )}
              aria-hidden
            />
            {expanded ? t('rooms:transcript.toolHide') : t('rooms:transcript.toolDetails')}
          </button>
        )}
      </div>
      {expanded && hasDetails && (
        <div
          className="mt-2 ml-1.5 space-y-3 border-l border-border pl-3"
          data-testid="tool-trace-details"
        >
          {calls.map((c, i) => {
            const tone = TONE_CLASSES[toneFor(c)]
            const Icon = toolIcon(c.name)
            const rows = argRows(c.args)
            const isError = !c.ok
            return (
              <div key={`${c.name}-detail-${i}`} className="min-w-0 space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <Icon className={cn('size-3.5 shrink-0', tone.icon)} aria-hidden />
                  <span className="text-foreground">{c.name}</span>
                  <span
                    className={cn(
                      'ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium',
                      isError
                        ? 'bg-destructive-tint text-destructive'
                        : 'bg-success-tint text-success'
                    )}
                  >
                    {isError ? t('rooms:transcript.toolFailed') : t('rooms:transcript.toolOk')}
                  </span>
                </div>
                {rows.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t('rooms:transcript.toolArgs')}
                    </p>
                    <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-code px-3 py-2">
                      {rows.map(([k, v], r) => (
                        <div key={`${k}-${r}`} className="col-span-2 grid grid-cols-subgrid">
                          {k ? (
                            <dt className="truncate font-mono text-[11px] text-muted-foreground">
                              {k}
                            </dt>
                          ) : (
                            <dt className="sr-only">value</dt>
                          )}
                          <dd
                            className={cn(
                              'min-w-0 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground',
                              k ? '' : 'col-span-2'
                            )}
                          >
                            {v}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
                {c.output && (
                  <div className="space-y-1">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {isError ? t('rooms:transcript.toolError') : t('rooms:transcript.toolOutput')}
                    </p>
                    <pre
                      className={cn(
                        'max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md px-3 py-2 font-mono text-[11px]',
                        isError
                          ? 'border border-destructive/30 bg-destructive-tint text-destructive'
                          : 'bg-code text-foreground'
                      )}
                    >
                      {c.output}
                    </pre>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function MessageBody({
  message,
  tally,
  mentionColors,
  t,
}: {
  message: RoomMessage
  tally: VoteTally | undefined
  mentionColors: Map<string, string>
  t: T
}) {
  return (
    <>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <ToolTrace calls={message.toolCalls} t={t} />
      )}
      <RoomMessageText
        text={stripConclusion(message.text).text}
        mentionColors={mentionColors}
        className="text-sm"
      />
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
          className="mt-3 rounded-md border border-warning/40 bg-warning-tint p-3"
        >
          <h4 className="mb-1 text-xs font-semibold text-warning">
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

/**
 * How close to the bottom (px) still counts as "following the conversation".
 * Wide enough to survive sub-pixel rounding and the growth of a single
 * streamed line, narrow enough that a deliberate scroll up drops follow at once.
 */
const NEAR_BOTTOM_PX = 64

export function RoomTranscript({ room, journal, liveTurn }: RoomTranscriptProps) {
  const { t } = useTranslation()
  const messages = useMemo(() => messagesOf(journal), [journal])
  const tallies = useMemo(() => voteTallies(messages), [messages])
  // Name -> color for the participants, so an @mention of one is painted in the
  // same color as that participant's name. Rebuilt only when the roster changes.
  const mentionColors = useMemo(() => participantColorsByName(room), [room])
  const live = liveTurn?.roomId === room.id ? liveTurn : null

  const scrollRef = useRef<HTMLDivElement>(null)
  // Whether new content should pull the viewport down. True only while the user
  // is at (or near) the bottom; a scroll upward turns it off so streaming tokens
  // never yank the reader back down, and returning to the bottom turns it on.
  const [follow, setFollow] = useState(true)
  const followRef = useRef(follow)
  followRef.current = follow

  const isNearBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setFollow(true)
  }, [])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // React to where the *user* is, not to programmatic jumps: both update
    // scrollTop, but a programmatic jump lands near the bottom and keeps follow.
    setFollow(isNearBottom(el))
  }, [isNearBottom])

  // Follow new messages and streamed tokens only while the user is at the
  // bottom. useLayoutEffect pins to the bottom before paint so appended content
  // never flashes a mid-scroll frame. When not following, do nothing: the
  // browser keeps scrollTop measured from the top, so appended content below
  // leaves the reader's position untouched.
  useLayoutEffect(() => {
    if (!followRef.current) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length, live?.text, live?.author])

  const showJump = !follow

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      tabIndex={0}
      data-testid="room-transcript-scroll"
      className="relative flex-1 min-h-0 overflow-y-auto outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
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
                <AuthorName author={m.author} room={room} t={t} />
                {chip && (
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">
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
              <MessageBody
                message={m}
                tally={tallies.get(m.id)}
                mentionColors={mentionColors}
                t={t}
              />
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
            <AuthorName author={live.author} room={room} t={t} />
            <span className="text-muted-foreground motion-safe:animate-pulse">
              {t(live.compacting ? 'rooms:transcript.compacting' : 'rooms:transcript.streaming')}
            </span>
          </header>
          {live.compacting ? (
            <p className="text-sm text-muted-foreground">{t('rooms:transcript.compactingBody')}</p>
          ) : (
            <RoomMessageText
              text={stripConclusion(live.text).text}
              mentionColors={mentionColors}
              isStreaming
              className="text-sm"
            />
          )}
        </article>
      )}
      </div>
      {/*
        Sticky within the scroll port, so it hovers over the newest messages
        only while the reader has scrolled away from the bottom. Selecting it
        returns to the latest and re-arms auto-follow. `pointer-events-none` on
        the centering row lets clicks fall through to the transcript except on
        the button itself.
      */}
      {showJump && (
        <div className="pointer-events-none sticky bottom-3 flex justify-center">
          <button
            type="button"
            onClick={scrollToBottom}
            data-testid="room-jump-latest"
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground shadow-md outline-hidden hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
          >
            <ArrowDown className="size-3.5" aria-hidden />
            {t('rooms:transcript.jumpToLatest')}
          </button>
        </div>
      )}
    </div>
  )
}
