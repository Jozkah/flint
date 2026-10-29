import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ArrowDown } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, memo } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'

export type ConversationProps = ComponentProps<typeof StickToBottom>

export const Conversation = memo(({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn('relative flex-1 overflow-y-hidden', className)}
    initial="instant"
    // Instant: a smooth spring trails content that grows many times a second
    // (streaming text, tool cards opening and closing) and then catches up in
    // jumps, so the view bounced up and down instead of holding the bottom.
    resize="instant"
    role="log"
    {...props}
  />
))

Conversation.displayName = 'Conversation'

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export const ConversationContent = memo(({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn('flex flex-col gap-x-8 gap-y-2 px-2', className)}
    {...props}
  />
))

ConversationContent.displayName = 'ConversationContent'

/**
 * Top-of-list control for a windowed transcript: reaching it (scrolling up, or
 * the button for keyboard users) mounts earlier messages, then restores the
 * scroll offset so the message the reader was on stays where it was.
 */
export const ConversationLoadEarlier = ({
  hidden,
  onLoad,
}: {
  /** How many earlier messages are not rendered. */
  hidden: number
  onLoad: () => void
}) => {
  const { t } = useTranslation()
  const { scrollRef } = useStickToBottomContext()
  const ref = useRef<HTMLButtonElement>(null)
  const pending = useRef<{ height: number; top: number } | null>(null)

  const load = useCallback(() => {
    const el = scrollRef.current
    if (el) pending.current = { height: el.scrollHeight, top: el.scrollTop }
    onLoad()
  }, [onLoad, scrollRef])

  useLayoutEffect(() => {
    const el = scrollRef.current
    const p = pending.current
    if (!el || !p) return
    pending.current = null
    el.scrollTop = p.top + (el.scrollHeight - p.height)
  }, [hidden, scrollRef])

  useEffect(() => {
    const node = ref.current
    const rootEl = scrollRef.current
    if (!node || !rootEl || typeof IntersectionObserver === 'undefined') return
    // Only after the reader scrolls up: when the newest messages do not fill
    // the view, the sentinel is visible from the start and would otherwise
    // keep mounting earlier messages nobody asked for.
    let lastTop = rootEl.scrollTop
    let near = false
    let fired = false
    const fire = () => {
      if (fired) return
      fired = true
      load()
    }
    const onScroll = () => {
      const up = rootEl.scrollTop < lastTop
      lastTop = rootEl.scrollTop
      if (up && near) fire()
    }
    rootEl.addEventListener('scroll', onScroll, { passive: true })
    const io = new IntersectionObserver(
      (entries) => {
        near = entries.some((e) => e.isIntersecting)
      },
      { root: rootEl, rootMargin: '400px 0px 0px 0px' }
    )
    io.observe(node)
    return () => {
      io.disconnect()
      rootEl.removeEventListener('scroll', onScroll)
    }
  }, [load, scrollRef, hidden])

  return (
    <button
      ref={ref}
      type="button"
      data-testid="conversation-load-earlier"
      className="mx-auto my-1 rounded-full px-3 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={load}
    >
      {t('common:coworkShowEarlier', { count: hidden })}
    </button>
  )
}

export type ConversationScrollButtonProps = ComponentProps<typeof Button>

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { t } = useTranslation()
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom()
  }, [scrollToBottom])

  return (
    !isAtBottom && (
      <Button
        className={cn(
          // A solid surface, so text scrolling under it never shows through.
          'absolute bottom-5 left-[50%] z-10 translate-x-[-50%] rounded-full border border-border bg-popover text-popover-foreground shadow-md hover:bg-accent dark:bg-popover dark:hover:bg-accent pointer-coarse:size-11',
          className
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        aria-label={t('common:scrollToBottom')}
        title={t('common:scrollToBottom')}
        {...props}
      >
        <ArrowDown className="size-4" aria-hidden="true" />
      </Button>
    )
  )
}
