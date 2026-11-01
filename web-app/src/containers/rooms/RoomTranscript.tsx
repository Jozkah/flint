import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { errorText } from '@/lib/errorText'
import { ArrowDown, ChevronDown, Globe, Link2, Search, Wrench } from 'lucide-react'
import { toneForTool, TONE_CLASSES } from '@/lib/semanticTone'
import { stripConclusion } from '@/lib/rooms/consensus'
import type {
  LiveTurn,
  Room,
  RoomAuthor,
  RoomJournalRecord,
  RoomChangeDecision,
  RoomMessage,
  RoomToolActivity,
  RoomChangedFile,
} from '@/lib/rooms/types'
import { changeCounts } from '@/lib/rooms/turnChanges'
import { ReplyCutOff } from '@/components/ReplyCutOff'
import { isCompareRoom } from '@/lib/rooms/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { liveStatus } from '@/lib/rooms/liveStatus'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { summarizeTrace, summaryLabelParts } from '@/lib/traceSummary'
import {
  addressLabel,
  compareLayout,
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
import { TurnChangeCard, type WorkspaceActions } from './TurnChangeCard'
import { CappedAnswer } from './CappedAnswer'
import { createScrollLink, ScrollLinkContext, useRoomsViewPrefs } from '@/lib/rooms/answerScroll'
import {
  applyRoomWorkspace,
  resetRoomWorkspace,
  roomWorkspaceApplyPreview,
  roomWorkspacePatch,
  undoRoomWorkspaceApply,
} from '@/services/rooms'
import { useRoomsApi } from './roomsBindings'
import { CompactionDivider } from '@/containers/CompactionDivider'
import { WidgetCard } from '@/containers/message/WidgetCard'
import { SHOW_WIDGET_TOOL } from '@/lib/visualize/constants'

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
function AuthorName({
  author,
  room,
  model,
  t,
}: {
  author: RoomAuthor
  room: Room | null
  /** The model that wrote this answer (compare), shown instead of the participant's current one. */
  model?: string
  t: T
}) {
  if (author.kind === 'participant') {
    const p = findParticipant(room, author.participantId)
    const name = p?.name || author.name || t('rooms:transcript.unknownParticipant')
    const full = model
      ? `${name} · ${model}${p?.removed ? ` ${t('rooms:transcript.removed')}` : ''}`
      : authorLabel(author, room, t)
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
    <p className={cn('whitespace-pre-wrap break-words text-[length:calc(var(--ui-font-base)*0.8125)] text-fg-2', className)}>
      {text}
    </p>
  )
}

function Badge({ tone, children }: { tone: 'warn' | 'error' | 'info'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-[7px] py-px text-[length:calc(var(--ui-font-base)*0.6875)]',
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

/** A call's duration in a compact, unit-only form ("340 ms", "2.5 s"). */
function formatToolDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

function ToolDuration({ ms }: { ms?: number }) {
  if (ms === undefined) return null
  return (
    <span
      data-testid="tool-duration"
      className="ml-auto font-mono text-[length:calc(var(--ui-font-base)*0.625)] tabular-nums text-muted-foreground"
    >
      {formatToolDuration(ms)}
    </span>
  )
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
          <p className="text-[length:calc(var(--ui-font-base)*0.6875)] font-medium text-muted-foreground">
            {t('rooms:transcript.toolArgs')}
          </p>
          <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-card px-3 py-2 shadow-[inset_0_0_0_0.8px_var(--border)]">
            {rows.map(([k, v], r) => (
              <div key={`${k}-${r}`} className="col-span-2 grid grid-cols-subgrid">
                {k ? (
                  <dt className="truncate font-mono text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground">{k}</dt>
                ) : (
                  <dt className="sr-only">value</dt>
                )}
                <dd
                  className={cn(
                    'min-w-0 overflow-auto whitespace-pre-wrap break-words font-mono text-[length:calc(var(--ui-font-base)*0.6875)] text-foreground',
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
          <p className="text-[length:calc(var(--ui-font-base)*0.6875)] font-medium text-muted-foreground">
            {isError ? t('rooms:transcript.toolError') : t('rooms:transcript.toolOutput')}
          </p>
          <pre
            className={cn(
              'overflow-auto whitespace-pre-wrap break-words rounded-md px-3 py-2 font-mono text-[length:calc(var(--ui-font-base)*0.6875)]',
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
function ToolTrace({
  calls,
  changes,
  t,
}: {
  calls: RoomToolActivity[]
  /** The turn's real diff, when it has one: its counts replace the calls' (R-046). */
  changes?: readonly RoomChangedFile[]
  t: T
}) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const hasDetails = calls.some((c) => c.args !== undefined || Boolean(c.output))
  const traced = summaryLabelParts(summarizeTrace(calls.map(asPart)), t as never)
  // The edit calls' old/new strings count unchanged context lines too; the
  // change card's diff is what the turn really changed, so both say the same.
  const diff = changes && changes.length > 0 ? changeCounts(changes) : null
  const summary =
    traced && diff ? { ...traced, added: diff.additions, removed: diff.deletions } : traced
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
                  <span className="text-diff-add">+{summary.added}</span>{' '}
                  <span className="text-diff-del">−{summary.removed}</span>
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
                      'inline-flex h-[22px] cursor-default items-center gap-[5px] rounded-md px-2 font-mono text-[length:calc(var(--ui-font-base)*0.71875)] outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40',
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
                    <ToolDuration ms={c.ms} />
                    <span
                      className={cn(
                        c.ms === undefined && 'ml-auto',
                        'rounded px-1.5 py-0.5 text-[length:calc(var(--ui-font-base)*0.625)] font-medium',
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
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-card font-mono text-[length:calc(var(--ui-font-base)*0.625)] tabular-nums text-muted-foreground shadow-[inset_0_0_0_0.8px_var(--border)]">
                    {i + 1}
                  </span>
                  <Icon className={cn('size-3.5 shrink-0', tone.icon)} aria-hidden />
                  <span className="font-mono text-foreground">{c.name}</span>
                  <ToolDuration ms={c.ms} />
                  <span
                    className={cn(
                      c.ms === undefined && 'ml-auto',
                      'rounded-full px-2 py-0.5 text-[length:calc(var(--ui-font-base)*0.625)] font-medium',
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

/** A drawn widget is shown as a card, not folded into the tool trace. */
const isWidgetCall = (c: RoomToolActivity): boolean =>
  c.name === SHOW_WIDGET_TOOL && c.ok

/** The workspace actions of an isolated participant's change card. */
function workspaceActions(message: RoomMessage): WorkspaceActions | undefined {
  if (!message.changes?.workspace || message.author.kind !== 'participant') return undefined
  const { roomId } = message
  const pid = message.author.participantId
  return {
    patch: () => roomWorkspacePatch(roomId, pid),
    discard: () => resetRoomWorkspace(roomId, pid),
    apply: (paths) => applyRoomWorkspace(roomId, pid, paths),
    preview: () => roomWorkspaceApplyPreview(roomId, pid),
    undo: () => undoRoomWorkspaceApply(roomId, pid),
    source: { name: message.author.name, round: message.round },
  }
}

/**
 * A participant turn that wrote no answer is never a blank cell: say why (the
 * reply limit ran out, or the turn only used tools) and show the thinking the
 * model spent its tokens on, folded as chat folds it.
 */
function EmptyReply({ message, t }: { message: RoomMessage; t: T }) {
  if (message.author.kind !== 'participant' || message.kind !== 'speech') return null
  if (message.status !== 'complete' || message.text.trim()) return null
  const why =
    message.finishReason === 'length'
      ? t('rooms:transcript.emptyReply.length', { count: message.usage?.outputTokens ?? 0 })
      : message.toolCalls?.length
        ? t('rooms:transcript.emptyReply.tools')
        : t('rooms:transcript.emptyReply.none')
  return (
    <div className="flex flex-col gap-1.5" data-testid="empty-reply">
      <p className="text-xs text-warning">{why}</p>
      {message.reasoning && (
        <details className="group text-xs text-muted-foreground" data-testid="empty-reply-thought">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 hover:text-foreground">
            <ChevronDown className="size-3 -rotate-90 transition-transform group-open:rotate-0" aria-hidden />
            {t('rooms:transcript.thought')}
          </summary>
          <p className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words border-l-2 border-border pl-2.5">
            {message.reasoning}
          </p>
        </details>
      )}
    </div>
  )
}

/**
 * The files a turn changed. Drawn under the capped answer, not inside it, so
 * the answer's fade and height cap never hide or clip the card.
 */
function MessageChanges({
  message,
  decision,
  t,
}: {
  message: RoomMessage
  decision?: RoomChangeDecision
  t: T
}) {
  const api = useRoomsApi()
  // Stable across re-renders: the apply dialog reloads when `load` changes.
  const actions = useMemo(() => workspaceActions(message), [message])
  if (!message.changes || message.changes.files.length === 0) return null
  return (
    <TurnChangeCard
      changes={message.changes}
      actions={actions}
      decision={decision}
      onDecision={(d) => api.controller.setChangeDecision(message.roomId, message.id, d)}
      t={t}
    />
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
  const api = useRoomsApi()
  return (
    <>
      {message.toolCalls && message.toolCalls.some((c) => !isWidgetCall(c)) && (
        <ToolTrace
          calls={message.toolCalls.filter((c) => !isWidgetCall(c))}
          changes={message.changes?.files}
          t={t}
        />
      )}
      {(message.toolCalls ?? []).filter(isWidgetCall).map((c, i) => (
        <WidgetCard
          key={`widget-${i}`}
          messageId={message.id}
          part={{
            type: 'tool-show_widget',
            toolCallId: `${message.id}-widget-${i}`,
            state: 'output-available',
            input: c.args as never,
            output: c.output,
          }}
        />
      ))}
      {message.compare?.catchUp && message.compare.catchUp.length > 0 && (
        <details data-testid="compare-catch-up" className="group text-xs text-muted-foreground">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium text-warning hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-3 -rotate-90 transition-transform group-open:rotate-0" aria-hidden />
            {t('rooms:transcript.catchUp', { count: message.compare.catchUp.length })}
          </summary>
          <p className="mt-1">{t('rooms:transcript.catchUpHint')}</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5">
            {message.compare.catchUp.map((q) => (
              <li key={q.id} className="break-words">
                {q.text}
              </li>
            ))}
          </ol>
        </details>
      )}
      <RoomMessageText
        text={stripConclusion(message.text).text}
        mentionColors={mentionColors}
        className="text-[length:calc(var(--ui-font-base)*0.84375)] leading-[1.6] text-fg-2"
      />
      <EmptyReply message={message} t={t} />
      {message.author.kind === 'participant' &&
        message.kind === 'speech' &&
        message.finishReason === 'length' &&
        message.text.trim() !== '' && (
          <ReplyCutOff
            tokens={message.usage?.outputTokens}
            // Outside compare, the participant is asked to carry on. A compare
            // cell is re-run from its own controls instead (a message there is
            // a new question for everyone).
            onContinue={
              message.compare
                ? undefined
                : () => {
                    const author = message.author as { participantId: string }
                    void api.controller.sendUserMessage(
                      message.roomId,
                      t('rooms:transcript.continuePrompt'),
                      { kind: 'participant', participantId: author.participantId }
                    )
                  }
            }
          />
        )}
      {message.budgetHit && (
        <p data-testid="budget-hit" className="text-xs text-warning">
          {t(`rooms:transcript.budgetHit.${message.budgetHit}`)}
        </p>
      )}
      {message.kind === 'vote-call' && (
        <p className="text-xs text-muted-foreground tabular-nums" data-testid="vote-tally">
          {t('rooms:transcript.tally', tally ?? { agree: 0, disagree: 0, abstain: 0 })}
        </p>
      )}
      {message.kind === 'moderator-note' &&
        message.directive &&
        message.directive.disagreements.length > 0 && (
          <div className="text-[length:calc(var(--ui-font-base)*0.78125)]">
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
          className="rounded-lg bg-warning-tint px-2.5 py-2 text-[length:calc(var(--ui-font-base)*0.78125)]"
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

/** One transcript message: a compaction divider, a system line or a card. */
function TranscriptMessage({
  m,
  room,
  tallies,
  mentionColors,
  isFresh,
  className,
  t,
}: {
  m: RoomMessage
  room: Room
  tallies: Map<string, VoteTally>
  mentionColors: Map<string, string>
  isFresh: (id: string) => boolean
  /** Extra classes for the card (a compare column fills its cell). */
  className?: string
  t: T
}) {
  const toUser = m.to.kind === 'user'
  const chip = addressLabel(m.to, room, t)
  if (m.kind === 'system' && m.compaction) {
    return (
      <div data-testid="room-message" data-kind="compaction">
        <CompactionDivider record={m.compaction} />
      </div>
    )
  }
  if (m.kind === 'system') {
    return (
      <div
        data-testid="room-message"
        data-kind={m.kind}
        className={cn(
          'px-2 text-center text-xs text-muted-foreground',
          isFresh(m.id) && 'motion-safe:animate-fade-in'
        )}
      >
        <span className="sr-only">{t('rooms:transcript.system')}: </span>
        <span className="whitespace-pre-wrap break-words">
          {m.note ? t(`rooms:notes.${m.note.key}`, m.note.values) : m.text}
        </span>
      </div>
    )
  }
  return (
    <article
      data-testid="room-message"
      data-kind={m.kind}
      data-status={m.status}
      data-addressed-to-user={toUser || undefined}
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-[10px] border-[0.8px] border-border bg-card px-3 py-2.5',
        m.kind === 'user' && 'bg-secondary',
        m.kind === 'synthesis' && 'border-[1.5px] border-border-strong',
        toUser && 'shadow-[inset_4px_0_0_var(--primary)]',
        isFresh(m.id) && 'motion-safe:animate-msg-in',
        className
      )}
    >
      <header className="flex flex-wrap items-center gap-1.5 text-xs">
        <AuthorName author={m.author} room={room} model={m.compare?.model} t={t} />
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
              'rounded-full px-[7px] py-px text-[length:calc(var(--ui-font-base)*0.6875)]',
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
          <span className="text-[length:calc(var(--ui-font-base)*0.71875)] font-medium text-foreground">
            {t('rooms:transcript.addressedToYou')}
          </span>
        )}
        {!m.compare && (m.usage?.outputTokens || m.usage?.tokensPerSecond) ? (
          <span
            data-testid="message-speed"
            title={t('rooms:transcript.speedTitle')}
            className="ml-auto tabular-nums text-muted-foreground"
          >
            {[
              m.usage?.outputTokens
                ? t('rooms:transcript.tokensOut', {
                    count: m.usage.outputTokens,
                    approx: m.usage.estimated ? '~' : '',
                  })
                : null,
              m.usage?.tokensPerSecond
                ? t('rooms:transcript.speed', { tps: Math.round(m.usage.tokensPerSecond) })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : null}
      </header>
      {m.compare && (
        <CompareAnswerMeta m={m} t={t} />
      )}
      <CappedAnswer messageId={m.id} name={authorLabel(m.author, room, t)} t={t}>
        <MessageBody
          message={m}
          tally={tallies.get(m.id)}
          mentionColors={mentionColors}
          t={t}
        />
      </CappedAnswer>
      <MessageChanges message={m} decision={room.changeDecisions?.[m.id]} t={t} />
    </article>
  )
}

/**
 * A compare answer's second header line: date · duration · tokens · tok/s,
 * muted. Each item keeps its own words together, so a narrow column wraps
 * between items, never inside one.
 */
function CompareAnswerMeta({ m, t }: { m: RoomMessage; t: T }) {
  const items = [
    answerDate(m.createdAt),
    m.compare?.durationMs ? `${(m.compare.durationMs / 1000).toFixed(1)} s` : null,
    m.usage?.outputTokens
      ? t('rooms:transcript.tokensOut', {
          count: m.usage.outputTokens,
          approx: m.usage.estimated ? '~' : '',
        })
      : null,
    m.usage?.tokensPerSecond
      ? t('rooms:transcript.speed', { tps: Math.round(m.usage.tokensPerSecond) })
      : null,
  ].filter((x): x is string => Boolean(x))
  return (
    <div
      data-testid="answer-meta"
      className="-mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-[24px] text-[length:calc(var(--ui-font-base)*0.6875)] tabular-nums text-muted-foreground"
    >
      {items.map((item, i) => (
        // The separator trails its item, so a wrapped line never starts with one.
        <span
          key={i}
          className="whitespace-nowrap after:ml-1.5 after:content-['·'] last:after:content-none"
        >
          {item}
        </span>
      ))}
    </div>
  )
}

/** The turn being streamed, drawn as a dashed card. */
function LiveCard({
  live,
  room,
  approvalTool,
  mentionColors,
  className,
  t,
}: {
  live: LiveTurn
  room: Room
  approvalTool: string | null
  mentionColors: Map<string, string>
  className?: string
  t: T
}) {
  return (
    <article
      data-testid="room-live-turn"
      aria-busy="true"
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-[10px] border-[0.8px] border-dashed border-border-strong bg-card px-3 py-2.5 motion-safe:animate-msg-in',
        className
      )}
    >
      <header className="flex flex-wrap items-center gap-1.5 text-xs">
        <AuthorName author={live.author} room={room} t={t} />
        <span className="text-muted-foreground motion-safe:animate-pulse">
          {liveStatusLabel(liveStatus(live, approvalTool), t)}
        </span>
      </header>
      <CappedAnswer name={authorLabel(live.author, room, t)} streamedLength={live.text.length} t={t}>
      {live.tools && live.tools.length > 0 && <ToolTrace calls={live.tools} t={t} />}
      {live.compacting ? (
        <p className="text-[length:calc(var(--ui-font-base)*0.8125)] text-muted-foreground">{t('rooms:transcript.compactingBody')}</p>
      ) : live.text ? (
        <RoomMessageText
          text={stripConclusion(live.text).text}
          mentionColors={mentionColors}
          isStreaming
          className="text-[length:calc(var(--ui-font-base)*0.84375)] leading-[1.6] text-fg-2"
        />
      ) : null}
      </CappedAnswer>
    </article>
  )
}

/** An answer's date and time, so runs of the same model on different days tell apart. */
function answerDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Where a participant's column goes: its order in the room, the removed last. */
function columnRank(room: Room, author: RoomAuthor): number {
  if (author.kind !== 'participant') return Number.MAX_SAFE_INTEGER
  const p = findParticipant(room, author.participantId)
  return p ? p.order : Number.MAX_SAFE_INTEGER
}

/**
 * A compare round: every participant's answer to the same user message in a
 * column of its own (stacked when the transcript is narrow), each headed by the
 * participant and model, with the same token and speed figures as any message.
 * Turns still being written sit in their column beside the finished ones.
 */
function CompareRow({
  answers,
  lives,
  room,
  tallies,
  mentionColors,
  isFresh,
  approvalTool,
  questionId = null,
  latest = false,
  onRun,
  t,
}: {
  answers: RoomMessage[]
  lives: LiveTurn[]
  room: Room
  /** The question this row answers; with it, models that have not answered show an empty cell. */
  questionId?: string | null
  /** The newest question: an empty cell runs just that model on it. */
  latest?: boolean
  onRun?: (participantId: string, scope: 'latest' | 'missing') => void
  tallies: Map<string, VoteTally>
  mentionColors: Map<string, string>
  isFresh: (id: string) => boolean
  approvalTool: string | null
  t: T
}) {
  const present = new Set(
    [...answers.map((m) => m.author), ...lives.map((l) => l.author)].flatMap((a) =>
      a.kind === 'participant' ? [a.participantId] : []
    )
  )
  const missing = questionId
    ? room.participants.filter((p) => !p.removed && !present.has(p.id))
    : []
  const cells = [
    ...answers.map((m) => ({ key: m.id, rank: columnRank(room, m.author), at: m.createdAt, message: m, live: null, empty: null })),
    ...lives.map((l) => ({ key: l.turnId, rank: columnRank(room, l.author), at: Number.MAX_SAFE_INTEGER, message: null, live: l, empty: null })),
    ...missing.map((p) => ({ key: `missing-${p.id}`, rank: p.order, at: 0, message: null, live: null, empty: p })),
  ].sort((a, b) => a.rank - b.rank || a.at - b.at)
  if (cells.length === 0) return null
  return (
    <CompareRowLinked>
    <div
      data-testid="room-compare-row"
      role="group"
      aria-label={t('rooms:transcript.compareRow', { count: cells.length })}
      // Wrapping flex, not a grid: when the answers do not all fit on one line the
      // last line's cells grow to fill it, so 3 answers at a narrow width are
      // 2 + 1 full-width, never 2 + an empty cell.
      className="flex flex-wrap items-stretch gap-2.5"
    >
      {cells.map((c) =>
        c.message ? (
          <TranscriptMessage
            key={c.key}
            m={c.message}
            room={room}
            tallies={tallies}
            mentionColors={mentionColors}
            isFresh={isFresh}
            className="min-w-0 flex-[1_1_min(100%,240px)]"
            t={t}
          />
        ) : c.live ? (
          <LiveCard
            key={c.key}
            live={c.live}
            room={room}
            approvalTool={approvalTool}
            mentionColors={mentionColors}
            className="min-w-0 flex-[1_1_min(100%,240px)]"
            t={t}
          />
        ) : c.empty ? (
          <div
            key={c.key}
            data-testid="compare-missing"
            className="flex min-w-0 flex-[1_1_min(100%,240px)] flex-col items-start gap-1.5 rounded-[10px] border-[0.8px] border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground"
          >
            <span className="font-medium text-foreground">{c.empty.name}</span>
            <span>
              {t(
                c.empty.compareSkip
                  ? 'rooms:compare.state.off'
                  : room.status === 'running' && latest
                    ? 'rooms:compare.state.queued'
                    : 'rooms:compare.notAnswered'
              )}
            </span>
            {onRun && room.status !== 'running' && (
              <button
                type="button"
                onClick={() => onRun(c.empty!.id, latest ? 'latest' : 'missing')}
                className="inline-flex h-7 cursor-pointer items-center rounded-full border-[0.8px] border-border bg-card px-2.5 text-[length:calc(var(--ui-font-base)*0.71875)] text-foreground outline-hidden hover:border-border-strong focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                {t(latest ? 'rooms:compare.run' : 'rooms:compare.answerEarlier')}
              </button>
            )}
          </div>
        ) : null
      )}
    </div>
    </CompareRowLinked>
  )
}

/** The answers of one row scroll together while Link scrolling is on. */
function CompareRowLinked({ children }: { children: React.ReactNode }) {
  const link = useMemo(() => createScrollLink(() => useRoomsViewPrefs.getState().linkScroll), [])
  return <ScrollLinkContext.Provider value={link}>{children}</ScrollLinkContext.Provider>
}

/** On by default; turns off the scroll link between compare columns. */
function LinkScrollToggle({ t }: { t: T }) {
  const on = useRoomsViewPrefs((s) => s.linkScroll)
  const set = useRoomsViewPrefs((s) => s.setLinkScroll)
  return (
    <Tooltip>
    <TooltipTrigger asChild>
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-testid="room-link-scroll"
      onClick={() => set(!on)}
      className={cn(
        // Stacked columns (a narrow transcript) have nothing to scroll side by side.
        '@max-[520px]:hidden inline-flex h-7 cursor-pointer items-center gap-1.5 self-end rounded-full border-[0.8px] px-2.5 text-[length:calc(var(--ui-font-base)*0.71875)] outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40',
        on ? 'border-border-strong bg-accent text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
      )}
    >
      <Link2 aria-hidden className="size-3.5" />
      {t('rooms:transcript.linkScroll')}
    </button>
    </TooltipTrigger>
    <TooltipContent side="bottom" align="end">
      {t('rooms:transcript.linkScrollHint')}
    </TooltipContent>
    </Tooltip>
  )
}

type RoomTranscriptProps = {
  room: Room
  journal: RoomJournalRecord[]
  liveTurn: LiveTurn | null
  /** Every turn in flight; a compare room streams one per participant. */
  liveTurns?: LiveTurn[]
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

export function RoomTranscript({ room, journal, liveTurn, liveTurns }: RoomTranscriptProps) {
  const { t } = useTranslation()
  const messages = useMemo(() => messagesOf(journal), [journal])
  const compare = isCompareRoom(room)
  const items = useMemo(() => (compare ? compareLayout(messages) : null), [compare, messages])
  const tallies = useMemo(() => voteTallies(messages), [messages])
  // Name -> color for the participants, so an @mention of one is painted in the
  // same color as that participant's name. Rebuilt only when the roster changes.
  const mentionColors = useMemo(() => participantColorsByName(room), [room])
  const live = liveTurn?.roomId === room.id ? liveTurn : null
  const compareLives = compare
    ? (liveTurns ?? (live ? [live] : [])).filter((l) => l.roomId === room.id)
    : []
  // Several turns stream at once in a compare room; any of them growing follows.
  const compareStreamed = compareLives.map((l) => l.text.length).join(',')
  const api = useRoomsApi()
  const onRun = (participantId: string, scope: 'latest' | 'missing') =>
    // A run that could not start says so instead of doing nothing (P2E-021).
    void api.controller
      .compareRun(room.id, [participantId], scope)
      .catch((e: unknown) => toast.error(errorText(e)))
  // Each live answer goes to the first question its model has not answered
  // (a late model answering earlier questions), else the newest one.
  const livesFor = useMemo(() => {
    const out = new Map<number, LiveTurn[]>()
    if (!items) return out
    const rows = items.flatMap((it, i) => (it.kind === 'compare' && it.questionId ? [i] : []))
    for (const l of compareLives) {
      const pid = l.author.kind === 'participant' ? l.author.participantId : ''
      const at =
        rows.find((i) => {
          const it = items[i] as Extract<(typeof items)[number], { kind: 'compare' }>
          return !it.answers.some(
            (m) => m.author.kind === 'participant' && m.author.participantId === pid && m.status === 'complete'
          )
        }) ?? rows.at(-1) ?? items.length - 1
      out.set(at, [...(out.get(at) ?? []), l])
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, compareLives.map((l) => l.turnId).join(',')])
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
  }, [messages.length, live?.text, live?.author, compareStreamed])

  const showJump = !follow

  // The visible height of the conversation, for the answer cap (CSS cannot
  // read a scroll port's height): an answer never outgrows the view.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => el.style.setProperty('--room-transcript-h', `${el.clientHeight}px`))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Messages already in the journal when it first loads appear at once; only
  // the ones that arrive afterwards rise in, so opening a room is not a cascade.
  const seenRef = useRef<Set<string> | null>(null)
  if (seenRef.current === null && messages.length > 0) {
    seenRef.current = new Set(messages.map((m) => m.id))
  }
  const isFresh = (id: string) => seenRef.current !== null && !seenRef.current.has(id)
  const shared = { room, tallies, mentionColors, isFresh, t }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="room-transcript">
    <div
      ref={scrollRef}
      onScroll={onScroll}
      tabIndex={0}
      data-testid="room-transcript-scroll"
      className="relative flex-1 min-h-0 overflow-y-auto outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <div
        className={cn(
          '@container flex flex-col gap-3 pt-3 pb-3',
          // Side-by-side answers need more width than one column of speech.
          compare
            ? 'px-[max(12px,calc((100%-1200px)/2))]'
            : 'px-[max(12px,calc((100%-760px)/2))]'
        )}
      >
      {compare && items?.some((x) => x.kind === 'compare') && <LinkScrollToggle t={t} />}
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={t('rooms:transcript.label')}
        className="flex flex-col gap-3"
      >
        {messages.length === 0 && !live && (
          <p className="mt-10 text-center text-[length:calc(var(--ui-font-base)*0.8125)] text-muted-foreground">
            {t('rooms:transcript.empty')}
          </p>
        )}
        {items
          ? items.map((item, i) =>
              item.kind === 'message' ? (
                <TranscriptMessage key={`msg:${item.message.id}`} m={item.message} {...shared} />
              ) : (
                <CompareRow
                  // A row is keyed by its question, which is also a message sibling.
                  key={`row:${item.questionId ?? item.answers[0]?.id ?? i}`}
                  answers={item.answers}
                  lives={livesFor.get(i) ?? []}
                  questionId={item.questionId}
                  latest={!items.slice(i + 1).some((x) => x.kind === 'compare' && x.questionId)}
                  onRun={onRun}
                  {...shared}
                  approvalTool={approvalTool}
                />
              )
            )
          : messages.map((m) => <TranscriptMessage key={m.id} m={m} {...shared} />)}
      </div>
      {items && compareLives.length > 0 && !items.some((x) => x.kind === 'compare') && (
        <CompareRow answers={[]} lives={compareLives} {...shared} approvalTool={approvalTool} />
      )}
      {!items && live && (
        <LiveCard live={live} room={room} approvalTool={approvalTool} mentionColors={mentionColors} t={t} />
      )}
      </div>
    </div>
      {/*
        Its own row under the conversation, just above the dock, so it never
        sits over a message. Shown only while the reader has scrolled away from
        the bottom; selecting it returns to the latest and re-arms auto-follow.
      */}
      {showJump && (
        <div className="flex shrink-0 justify-center py-1.5" data-testid="room-jump-row">
          <button
            type="button"
            onClick={scrollToBottom}
            data-testid="room-jump-latest"
            data-placement="above-dock"
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border-[0.8px] border-border bg-popover px-3 text-xs text-foreground shadow-pop outline-hidden transition-transform duration-150 ease-expo hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.96] motion-safe:animate-pop"
          >
            <ArrowDown className="size-[13px]" aria-hidden />
            {t('rooms:transcript.jumpToLatest')}
          </button>
        </div>
      )}
    </div>
  )
}
