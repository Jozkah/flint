/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { usePreviewSummary } from '@/hooks/usePreviewSummary'
import { useSessionPrList } from '@/hooks/useSessionPrList'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import {
  PREVIEW_CARD_CLASS,
  PREVIEW_CLOSE_DELAY,
  PREVIEW_OPEN_DELAY,
  PreviewCard,
  PreviewPullRequests,
  type PreviewMeta,
  type PreviewStatus,
} from '@/components/shell/nav/PreviewCard'

/** The card's gap from the row when no sidebar edge is found (tests, previews). */
export const PREVIEW_SIDE_OFFSET = 10

/**
 * How far right of the row the card starts: 8px past the sidebar (`aside`)
 * the row sits in, so the card never covers the row's trailing menu button
 * or the sidebar's scrollbar; the default gap outside a sidebar.
 */
export function previewSideOffset(row: HTMLElement): number {
  const aside = row.closest('aside')
  if (!aside) return PREVIEW_SIDE_OFFSET
  const gap = aside.getBoundingClientRect().right - row.getBoundingClientRect().right + 8
  return Number.isFinite(gap) && gap > 0 ? gap : PREVIEW_SIDE_OFFSET
}

/** Facts read from disk when the card opens, never to draw the row. */
export type PreviewFacts = { first?: string; count: number }

export type RowPreviewProps = {
  title: string
  status?: PreviewStatus
  /** Where it works, on what, and when; `messages` may come from `facts`. */
  meta?: PreviewMeta
  /** The model it runs on, resolved to a display name for the card. */
  model?: { provider: string; id: string } | null
  /** The plain line shown until (or instead of) a written summary. */
  summary?: string
  /**
   * Names the conversation in its current state (id, then a NUL, then its
   * last-updated time) so a summary is made once and redone only on change.
   */
  summaryKey?: string
  /** The conversation as text; called when the card opens. */
  transcript?: () => Promise<string> | string
  /**
   * The first thing asked and the message count, read when the card opens
   * (a chat's messages are on disk, not in the row).
   */
  facts?: () => Promise<PreviewFacts>
  /** The session whose pull requests the card lists. */
  pullRequests?: { sessionId: string; folder: string | null | undefined }
  /** Shut while the row's menu is open, so the card cannot cover it. */
  suppressed: boolean
  children: ReactNode
}

/**
 * Closes the card open now, if any. One card at a time: a card opening on
 * another row shuts the previous one at once instead of fading out under it.
 */
let closeOpenCard: (() => void) | null = null

/**
 * A peek at a nav row without opening it: the same card for chats, Cowork
 * sessions and rooms (`PreviewCard`), opened by a resting pointer or keyboard
 * focus and never over the row's own menu.
 */
export function RowPreview({
  title,
  status,
  meta,
  model,
  summary,
  summaryKey,
  transcript,
  facts,
  pullRequests,
  suppressed,
  children,
}: RowPreviewProps) {
  const [open, setOpen] = useState(false)
  // Forget a hover that began before the menu or a dialog opened; otherwise the
  // card returns as soon as `suppressed` clears (a picked menu item).
  useEffect(() => {
    if (suppressed) setOpen(false)
  }, [suppressed])
  // The card is a hover peek, so it opens only while the pointer rests on the
  // row and the row was not pressed. Radix also opens it on focus, and its open
  // timer outlives a click: opening a long session (focus put back on the row,
  // or the timer firing after the load stalled the page) showed the card with
  // the pointer elsewhere.
  const hovered = useRef(false)
  const pressed = useRef(false)
  // Tabbing onto the row opens the card too; a focus that did not come from the
  // keyboard (focus handed back after a click) does not.
  const keyboardFocus = useRef(false)
  const [byKeyboard, setByKeyboard] = useState(false)
  // The card's links are reachable from the row (ArrowRight moves focus in).
  // While focus is inside, the card stays open; Escape closes it and returns
  // focus to the row.
  const rowEl = useRef<HTMLElement | null>(null)
  const cardEl = useRef<HTMLElement | null>(null)
  // Read live, never cached in a ref: a card that unmounts with focus inside
  // fires no blur, so a cached flag stayed true and every later close was
  // ignored (the card stuck open). Only keyboard (focus-visible) focus holds
  // the card; a mouse click that focused a link in it does not.
  const keyboardFocusInside = () => {
    const active = document.activeElement as HTMLElement | null
    if (!active || !cardEl.current?.contains(active)) return false
    try {
      return active.matches(':focus-visible')
    } catch {
      return false
    }
  }
  // The card opens past the sidebar's edge, not the row's: a row ends before
  // its trailing menu button and the sidebar's own scrollbar, which the card
  // would otherwise cover.
  const [sideOffset, setSideOffset] = useState(PREVIEW_SIDE_OFFSET)
  const measure = (el: HTMLElement) => setSideOffset(previewSideOffset(el))
  const shown = open && !suppressed
  useEffect(() => {
    if (!shown) return
    closeOpenCard?.()
    const close = () => setOpen(false)
    closeOpenCard = close
    return () => {
      if (closeOpenCard === close) closeOpenCard = null
    }
  }, [shown])
  return (
    <HoverCard
      openDelay={PREVIEW_OPEN_DELAY}
      closeDelay={PREVIEW_CLOSE_DELAY}
      open={shown}
      onOpenChange={(next) => {
        if (!next && keyboardFocusInside()) return
        const allowed =
          next && (hovered.current || keyboardFocus.current) && !pressed.current
        setOpen(allowed)
        if (allowed) setByKeyboard(!hovered.current && keyboardFocus.current)
      }}
    >
      <HoverCardTrigger
        asChild
        onFocus={(e: React.FocusEvent<HTMLElement>) => {
          rowEl.current = e.currentTarget
          measure(e.currentTarget)
          try {
            keyboardFocus.current = e.currentTarget.matches(':focus-visible')
          } catch {
            keyboardFocus.current = false
          }
        }}
        onBlur={(e: React.FocusEvent<HTMLElement>) => {
          // Focus moving into the card keeps the peek keyboard-driven.
          if (!cardEl.current?.contains(e.relatedTarget as Node | null)) {
            keyboardFocus.current = false
          }
        }}
        onKeyDown={(e: React.KeyboardEvent<HTMLElement>) => {
          if (e.key !== 'ArrowRight' || !shown || !byKeyboard) return
          const link = cardEl.current?.querySelector<HTMLElement>(
            'a[href], button'
          )
          if (!link) return
          e.preventDefault()
          link.focus()
        }}
        onPointerEnter={(e: React.PointerEvent<HTMLElement>) => {
          hovered.current = true
          measure(e.currentTarget)
        }}
        onPointerLeave={() => {
          hovered.current = false
          pressed.current = false
        }}
        onPointerDown={() => {
          pressed.current = true
          setOpen(false)
        }}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={sideOffset}
        collisionPadding={12}
        className={PREVIEW_CARD_CLASS}
        ref={(el: HTMLDivElement | null) => {
          cardEl.current = el
        }}
        onKeyDown={(e: React.KeyboardEvent<HTMLElement>) => {
          if (e.key !== 'Escape') return
          e.stopPropagation()
          setOpen(false)
          rowEl.current?.focus()
        }}
      >
        {/* Mounted only while open, so the summary, the disk read and the
            pull-request lookups happen on a peek and never for a row. */}
        <RowPreviewBody
          title={title}
          status={status}
          meta={meta}
          model={model}
          summary={summary}
          summaryKey={summaryKey}
          transcript={transcript}
          facts={facts}
          pullRequests={pullRequests}
          hint={byKeyboard}
        />
      </HoverCardContent>
    </HoverCard>
  )
}

function RowPreviewBody({
  title,
  status,
  meta,
  model,
  summary,
  summaryKey,
  transcript,
  facts,
  pullRequests,
  hint,
}: Omit<RowPreviewProps, 'suppressed' | 'children'> & { hint: boolean }) {
  const written = usePreviewSummary(summaryKey, true, transcript)
  const [read, setRead] = useState<PreviewFacts>()
  useEffect(() => {
    if (!facts) return
    let current = true
    void facts()
      .then((f) => {
        if (current) setRead(f)
      })
      .catch((e) => {
        // The card still shows without its facts.
        console.error('[row-preview] facts failed:', e)
      })
    return () => {
      current = false
    }
    // Called once per open; the key says which conversation state it is for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryKey])
  // A thread that never picked a model carries the id '*' (or none): that is
  // "use the default", not a model to name on the card.
  const picked = model && model.id && model.id !== '*' ? model : null
  const modelName = useModelProvider((s) =>
    picked
      ? s.providers
          .find((p) => p.provider === picked.provider)
          ?.models.find((m) => m.id === picked.id)?.displayName
      : undefined
  )
  const messages = meta?.messages ?? read?.count
  return (
    <PreviewCard
      title={title}
      status={status}
      meta={{
        ...meta,
        model: meta?.model ?? modelName ?? picked?.id,
        messages,
      }}
      summary={written.summary ?? summary ?? read?.first}
      summaryLoading={written.loading && !written.summary}
      pullRequests={
        pullRequests ? (
          <SessionPullRequests
            sessionId={pullRequests.sessionId}
            folder={pullRequests.folder}
          />
        ) : undefined
      }
      hint={hint}
    />
  )
}

function SessionPullRequests({
  sessionId,
  folder,
}: {
  sessionId: string
  folder: string | null | undefined
}) {
  const { prs, loading, error } = useSessionPrList(sessionId, folder)
  return <PreviewPullRequests prs={prs} loading={loading} error={error} />
}

/** The text of the last thing the user asked, from AI SDK UI messages. */
export function lastUserText(
  messages:
    | { role: string; parts?: { type: string; text?: string }[] }[]
    | undefined
): string | undefined {
  if (!messages) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const text = m.parts?.find((p) => p.type === 'text')?.text
    if (text) return text
  }
  return undefined
}

/**
 * A folder as breadcrumb segments: its last two names, so `C:\Projects\acme-
 * weather\web` reads "acme-weather › web" and a worktree's own folder names
 * the repository it was cut from.
 */
export function placeOf(folder: string | null | undefined, depth = 2): string[] {
  if (!folder) return []
  const parts = folder.split(/[\\/]+/).filter((p) => p && !/^[a-zA-Z]:$/.test(p))
  return parts.slice(-depth)
}
