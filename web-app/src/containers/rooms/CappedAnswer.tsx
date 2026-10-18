import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  ANSWER_MAX_HEIGHT,
  atScrollBottom,
  scrollRange,
  useRoomsViewPrefs,
  ScrollLinkContext,
} from '@/lib/rooms/answerScroll'


type T = (key: string, options?: Record<string, unknown>) => string

/**
 * An answer's body, capped in height with its own scroll, a fade at the
 * bottom edge while more is below, and Expand / Collapse (remembered per
 * message). A streamed answer keeps following its newest words only while the
 * reader is at the bottom of this cell.
 */
export function CappedAnswer({
  messageId,
  name,
  streamedLength,
  children,
  t,
}: {
  /** Remembers Expand; absent for a turn still being written. */
  messageId?: string
  name: string
  /** Grows while the answer streams in. */
  streamedLength?: number
  children: React.ReactNode
  t: T
}) {
  const link = useContext(ScrollLinkContext)
  const expanded = useRoomsViewPrefs((s) => (messageId ? Boolean(s.expanded[messageId]) : false))
  const toggle = useRoomsViewPrefs((s) => s.toggleExpanded)
  const ref = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [more, setMore] = useState(false)
  const follow = useRef(true)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const over = scrollRange(el) > 1
    setOverflow(over)
    setMore(over && !atScrollBottom(el))
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el || !link) return
    return link.add(el)
  }, [link])

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [measure])

  useLayoutEffect(() => {
    const el = ref.current
    if (el && streamedLength !== undefined && follow.current && !expanded) {
      el.scrollTop = el.scrollHeight
    }
    measure()
  }, [streamedLength, expanded, measure])

  return (
    <div className="relative flex min-w-0 flex-col">
      <div
        ref={ref}
        role="region"
        tabIndex={0}
        aria-label={t('rooms:transcript.answerFrom', { name })}
        data-testid="room-answer-body"
        data-capped={!expanded || undefined}
        onScroll={(e) => {
          const el = e.currentTarget
          follow.current = atScrollBottom(el)
          measure()
          link?.onScroll(el)
        }}
        style={expanded ? undefined : { maxHeight: ANSWER_MAX_HEIGHT }}
        className={cn(
          'room-answer flex min-w-0 flex-col gap-1.5 rounded-md outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40',
          !expanded && 'overflow-y-auto overscroll-contain [scrollbar-width:thin]'
        )}
      >
        <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
      </div>
      {more && !expanded && (
        <div
          aria-hidden
          data-testid="room-answer-fade"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-card"
          style={overflow && messageId ? { bottom: '1.75rem' } : undefined}
        />
      )}
      {messageId && (overflow || expanded) && (
        <button
          type="button"
          onClick={() => toggle(messageId)}
          aria-expanded={expanded}
          data-testid="room-answer-expand"
          aria-label={t(expanded ? 'rooms:transcript.collapseAnswer' : 'rooms:transcript.expandAnswer', { name })}
          className="mt-1 inline-flex h-6 cursor-pointer items-center gap-1 self-start rounded-md px-1 text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <ChevronDown aria-hidden className={cn('size-3 transition-transform', expanded && 'rotate-180')} />
          {t(expanded ? 'rooms:transcript.collapse' : 'rooms:transcript.expand')}
        </button>
      )}
    </div>
  )
}
