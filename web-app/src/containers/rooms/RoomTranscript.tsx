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
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { liveStatus } from '@/lib/rooms/liveStatus'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { summarizeTrace, summaryLabelParts } from '@/lib/traceSummary'
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
import { RoomAvatar } from './RoomAvatar'
import { CompactionDivider } from '@/containers/CompactionDivider'

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
 * The message author in the transcript header: the model's logo, then the
 * name in the participant's stable color (the same color their `@mentions`
 * get), with the role and model kept muted beside it so the name is what the
 * color highlights.
 */
function AuthorName({ author, room, t }: { author: RoomAuthor; room: Room | null; t: T }) {
  if (author.kind === 'participant') {
    const p = findParticipant(room, author.participantId)
    const name = p?.name || author.name || t('rooms:transcript.unknownParticipant')
    const full = authorLabel(author, room, t)
    return (
      <>
        <RoomAvatar
          model={p?.model}
          name={name}
          color={participantColor(author.participantId)}
          size={18}
        />
        <span className="min-w-0" title={full}>
          <span className="font-semibold" style={{ color: participantColor(author.participantId) }}>
            {name}
          </span>
          <span className="text-muted-foreground">{full.slice(name.length)}</span>
        </span>
      </>
    )
  }
  return <span className="font-semibold text-foreground">{authorLabel(author, room, t)}</span>
}

/** Model output is untrusted: always plain text, whitespace preserved. */
function PlainText({ text, className }: { text: string; className?: string }) {
  return (
    <p className={cn('whitespace-pre-wrap break-words text-[13px] text-fg-2', className)}>
      {text}
    </p>
  )
}

function Badge({ tone, children }: { tone: 'warn' | 'error' | 'info'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-[7px] py-px text-[11px]',
        tone === 'error' && 'bg-destructive-tint font-medium text-destructive',
        tone === 'warn' && 'bg-warning-tint font-medium text-warning',
        tone === 'info' && 'bg-accent text-muted-foreground'
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

/** A room tool call as the trace summary reads a tool part. */
const asPart = (c: RoomToolActivity) => ({
  type: `tool-${c.name}`,
  state: c.ok ? 'output-available' : 'output-error',
  input: c.args,
  output: c.output,
})

/** What one call was given and what came back: the body of the popup and of Details. */
function ToolCallBody({
  c,
  t,
  compact,
}: {
  c: RoomToolActivity
  t: T
  compact?: boolean
}) {
  const rows = argRows(c.args)
  const isError = !c.ok
  return (
    <>
      {rows.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-muted-foreground">
            {t('rooms:transcript.toolArgs')}
          </p>
          <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-card px-3 py-2 shadow-[inset_0_0_0_0.8px_var(--border)]">
            {rows.map(([k, v], r) => (
              <div key={`${k}-${r}`} className="col-span-2 grid grid-cols-subgrid">
                {k ? (
                  <dt className="truncate font-mono text-[11px] text-muted-foreground">{k}</dt>
                ) : (
                  <dt className="sr-only">value</dt>
                )}
                <dd
                  className={cn(
                    'min-w-0 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground',
                    compact ? 'max-h-16' : 'max-h-24',
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
              'overflow-auto whitespace-pre-wrap break-words rounded-md px-3 py-2 font-mono text-[11px]',
              compact ? 'max-h-32' : 'max-h-40',
              isError
                ? 'border border-destructive/30 bg-destructive-tint text-destructive'
                : 'bg-card text-foreground shadow-[inset_0_0_0_0.8px_var(--border)]'
            )}
          >
            {c.output}
          </pre>
        </div>
      )}
    </>
  )
}

/**
 * The tools a participant used, folded by default to one line that says what
 * they did ("Ran 10 commands, edited 1 file (4 failed)"). Opening it shows one
 * chip per call, tone-coloured as in the Cowork tab (built-in indigo, read cyan,
 * write amber, MCP violet, failures red); hovering a chip shows what that call
 * was given and what came back. Details opens every call as a full table.
 */
function ToolTrace({ calls, t }: { calls: RoomToolActivity[]; t: T }) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const hasDetails = calls.some((c) => c.args !== undefined || Boolean(c.output))
  const summary = summaryLabelParts(summarizeTrace(calls.map(asPart)), t as never)
  const failed = calls.filter((c) => !c.ok).length

  return (
    <div data-testid="message-tools">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="tool-trace-summary"
          className="inline-flex min-h-6 cursor-pointer items-center gap-1 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              'size-3 shrink-0 transition-transform duration-200',
              open ? 'rotate-0' : '-rotate-90'
            )}
            aria-hidden
          />
          {summary ? (
            <>
              {summary.text}
              {(summary.added > 0 || summary.removed > 0) && (
                <span className="ml-1 font-mono tabular-nums">
                  <span className="text-emerald-600 dark:text-emerald-400">+{summary.added}</span>{' '}
                  <span className="text-red-600 dark:text-red-400">−{summary.removed}</span>
                </span>
              )}
            </>
          ) : (
            <>
              {t('chat:transcriptView.steps', { count: calls.length })}
              {failed > 0 && <span className="text-destructive"> · {failed}</span>}
            </>
          )}
        </button>
        {open &&
          calls.map((c, i) => {
            const tone = TONE_CLASSES[toneFor(c)]
            const Icon = toolIcon(c.name)
            // Match Cowork: a neutral chip whose icon carries the tool's kind
            // colour, and a red tint only when the call failed.
            return (
              <HoverCard key={`${c.name}-${i}`} openDelay={150} closeDelay={80}>
                <HoverCardTrigger asChild>
                  <span
                    tabIndex={0}
                    data-testid="tool-chip"
                    className={cn(
                      'inline-flex h-[22px] cursor-default items-center gap-[5px] rounded-md px-2 font-mono text-[11.5px] outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40',
                      c.ok ? 'bg-accent text-secondary-foreground' : 'bg-destructive-tint text-destructive'
                    )}
                  >
                    <Icon
                      className={cn('size-3 shrink-0', c.ok ? tone.icon : 'text-destructive')}
                      aria-hidden
                    />
                    {c.name}
                  </span>
                </HoverCardTrigger>
                <HoverCardContent
                  side="top"
                  align="start"
                  className="w-96 max-w-[calc(100vw-2rem)] space-y-2 p-3"
                >
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <Icon className={cn('size-3.5 shrink-0', tone.icon)} aria-hidden />
                    <span className="text-foreground">{c.name}</span>
                    <span
                      className={cn(
                        'ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium',
                        c.ok ? 'bg-success-tint text-success' : 'bg-destructive-tint text-destructive'
                      )}
                    >
                      {c.ok ? t('rooms:transcript.toolOk') : t('rooms:transcript.toolFailed')}
                    </span>
                  </div>
                  <ToolCallBody c={c} t={t} compact />
                </HoverCardContent>
              </HoverCard>
            )
          })}
        {open && hasDetails && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            data-testid="tool-trace-toggle"
            className="inline-flex cursor-pointer items-center gap-[3px] rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                'size-3 shrink-0 transition-transform duration-200',
                expanded ? 'rotate-0' : '-rotate-90'
              )}
              aria-hidden
            />
            {expanded ? t('rooms:transcript.toolHide') : t('rooms:transcript.toolDetails')}
          </button>
        )}
      </div>
      {open && expanded && hasDetails && (
        <div className="mt-2 space-y-3 motion-safe:animate-dd-in" data-testid="tool-trace-details">
          {calls.map((c, i) => {
            const tone = TONE_CLASSES[toneFor(c)]
            const Icon = toolIcon(c.name)
            // Each call is a card of its own: numbered, headed, with room between
            // what it was given and what came back.
            return (
              <div
                key={`${c.name}-detail-${i}`}
                data-testid="tool-detail"
                className={cn(
                  'min-w-0 overflow-hidden rounded-lg border-[0.8px] bg-muted',
                  c.ok ? 'border-border' : 'border-destructive/40'
                )}
              >
                <div
                  className={cn(
                    'flex items-center gap-2 border-b-[0.8px] px-3 py-2 text-xs font-medium',
                    c.ok ? 'border-border bg-accent/40' : 'border-destructive/30 bg-destructive-tint'
                  )}
                >
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-card font-mono text-[10px] tabular-nums text-muted-foreground shadow-[inset_0_0_0_0.8px_var(--border)]">
                    {i + 1}
                  </span>
                  <Icon className={cn('size-3.5 shrink-0', tone.icon)} aria-hidden />
                  <span className="font-mono text-foreground">{c.name}</span>
                  <span
                    className={cn(
                      'ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium',
                      c.ok ? 'bg-success-tint text-success' : 'bg-destructive-tint text-destructive'
                    )}
                  >
                    {c.ok ? t('rooms:transcript.toolOk') : t('rooms:transcript.toolFailed')}
                  </span>
                </div>
                <div className="space-y-3 p-3">
                  <ToolCallBody c={c} t={t} />
                </div>
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
        className="text-[13.5px] leading-[1.6] text-fg-2"
      />
      {message.kind === 'vote-call' && (
        <p className="text-xs text-muted-foreground tabular-nums" data-testid="vote-tally">
          {t('rooms:transcript.tally', tally ?? { agree: 0, disagree: 0, abstain: 0 })}
        </p>
      )}
      {message.kind === 'moderator-note' &&
        message.directive &&
        message.directive.disagreements.length > 0 && (
          <div className="text-[12.5px]">
            <p className="font-semibold text-foreground">{t('rooms:transcript.disagreements')}</p>
            <ul className="mt-1 ml-[18px] list-disc text-muted-foreground">
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
          className="rounded-lg bg-warning-tint px-2.5 py-2 text-[12.5px]"
        >
          <h4 className="mb-1 text-xs font-semibold text-foreground">
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
        <p className="text-xs text-destructive" data-testid="message-error">
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

function liveStatusLabel(status: ReturnType<typeof liveStatus>, t: T): string {
  switch (status.kind) {
    case 'compacting':
      return t('rooms:transcript.compacting')
    case 'approval':
      return t('rooms:transcript.waitingApproval', { tool: status.tool })
    case 'tool':
      return `${status.text}…`
    case 'writing':
      return t('rooms:transcript.writing')
    default:
      return t('rooms:transcript.thinking')
  }
}

export function RoomTranscript({ room, journal, liveTurn }: RoomTranscriptProps) {
  const { t } = useTranslation()
  const messages = useMemo(() => messagesOf(journal), [journal])
  const tallies = useMemo(() => voteTallies(messages), [messages])
  // Name -> color for the participants, so an @mention of one is painted in the
  // same color as that participant's name. Rebuilt only when the roster changes.
  const mentionColors = useMemo(() => participantColorsByName(room), [room])
  const live = liveTurn?.roomId === room.id ? liveTurn : null
  const approvalTool = useToolApprovalRequests((s) => {
    for (const p of Object.values(s.pending ?? {})) if (p.threadId === room.id) return p.toolName
    return null
  })

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

  // Messages already in the journal when it first loads appear at once; only
  // the ones that arrive afterwards rise in, so opening a room is not a cascade.
  const seenRef = useRef<Set<string> | null>(null)
  if (seenRef.current === null && messages.length > 0) {
    seenRef.current = new Set(messages.map((m) => m.id))
  }
  const isFresh = (id: string) => seenRef.current !== null && !seenRef.current.has(id)

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      tabIndex={0}
      data-testid="room-transcript-scroll"
      className="relative flex-1 min-h-0 overflow-y-auto outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex flex-col gap-2.5 px-[max(16px,calc((100%-760px)/2))] pt-3.5 pb-2">
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={t('rooms:transcript.label')}
        className="flex flex-col gap-2.5"
      >
        {messages.length === 0 && !live && (
          <p className="mt-10 text-center text-[13px] text-muted-foreground">
            {t('rooms:transcript.empty')}
          </p>
        )}
        {messages.map((m) => {
          const toUser = m.to.kind === 'user'
          const chip = addressLabel(m.to, room, t)
          if (m.kind === 'system' && m.compaction) {
            return (
              <div key={m.id} data-testid="room-message" data-kind="compaction">
                <CompactionDivider record={m.compaction} />
              </div>
            )
          }
          if (m.kind === 'system') {
            return (
              <div
                key={m.id}
                data-testid="room-message"
                data-kind={m.kind}
                className={cn(
                  'px-2 text-center text-xs text-muted-foreground',
                  isFresh(m.id) && 'motion-safe:animate-fade-in'
                )}
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
                'flex min-w-0 flex-col gap-1.5 rounded-[10px] border-[0.8px] border-border bg-card px-3 py-2.5',
                m.kind === 'user' && 'bg-secondary',
                m.kind === 'synthesis' && 'border-[1.5px] border-border-strong',
                toUser && 'shadow-[inset_4px_0_0_var(--primary)]',
                isFresh(m.id) && 'motion-safe:animate-msg-in'
              )}
            >
              <header className="flex flex-wrap items-center gap-1.5 text-xs">
                <AuthorName author={m.author} room={room} t={t} />
                {m.usage?.tokensPerSecond ? (
                  <span
                    data-testid="message-speed"
                    title={t('rooms:transcript.speedTitle')}
                    className="tabular-nums text-muted-foreground"
                  >
                    {t('rooms:transcript.speed', { tps: Math.round(m.usage.tokensPerSecond) })}
                  </span>
                ) : null}
                {chip && (
                  <span
                    data-testid="message-to"
                    // A message to a participant wears that participant's colour,
                    // like their own name does.
                    style={
                      m.to.kind === 'participant'
                        ? {
                            color: participantColor(m.to.participantId),
                            backgroundColor: `color-mix(in oklab, ${participantColor(m.to.participantId)} 14%, transparent)`,
                          }
                        : undefined
                    }
                    className={cn(
                      'rounded-full px-[7px] py-px text-[11px]',
                      m.to.kind !== 'participant' && 'bg-accent text-muted-foreground'
                    )}
                  >
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
                  <span className="text-[11.5px] font-medium text-foreground">
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
          className="flex min-w-0 flex-col gap-1.5 rounded-[10px] border-[0.8px] border-dashed border-border-strong bg-card px-3 py-2.5 motion-safe:animate-msg-in"
        >
          <header className="flex flex-wrap items-center gap-1.5 text-xs">
            <AuthorName author={live.author} room={room} t={t} />
            <span className="text-muted-foreground motion-safe:animate-pulse">
              {liveStatusLabel(liveStatus(live, approvalTool), t)}
            </span>
          </header>
          {live.tools && live.tools.length > 0 && <ToolTrace calls={live.tools} t={t} />}
          {live.compacting ? (
            <p className="text-[13px] text-muted-foreground">{t('rooms:transcript.compactingBody')}</p>
          ) : live.text ? (
            <RoomMessageText
              text={stripConclusion(live.text).text}
              mentionColors={mentionColors}
              isStreaming
              className="text-[13.5px] leading-[1.6] text-fg-2"
            />
          ) : null}
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
            className="pointer-events-auto inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full bg-popover px-3 text-xs text-foreground shadow-pop outline-hidden transition-transform duration-150 ease-expo hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.965] motion-safe:animate-pop"
          >
            <ArrowDown className="size-[13px]" aria-hidden />
            {t('rooms:transcript.jumpToLatest')}
          </button>
        </div>
      )}
    </div>
  )
}
