import { useEffect, useMemo, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { findInMessages, rangesInElements } from '@/lib/findInMessages'

type Props = {
  messages: readonly UIMessage[]
  /** The element holding the rendered conversation. */
  root: () => HTMLElement | null
  onClose: () => void
}

const HIGHLIGHT_ALL = 'conv-find'
const HIGHLIGHT_ACTIVE = 'conv-find-active'

type HighlightRegistry = {
  set: (name: string, value: unknown) => void
  delete: (name: string) => void
}
const registry = (): HighlightRegistry | null =>
  (typeof CSS !== 'undefined' &&
    (CSS as unknown as { highlights?: HighlightRegistry }).highlights) ||
  null

/** The rendered elements of one message, without any nested inside another. */
function elementsOf(root: HTMLElement, messageId: string): Element[] {
  const found = Array.from(
    root.querySelectorAll(`[data-message-id="${CSS.escape(messageId)}"]`)
  )
  return found.filter((el) => !found.some((o) => o !== el && o.contains(el)))
}

/**
 * Find in the conversation on screen: type, Enter for the next match, Shift+Enter
 * for the previous one, Escape to close. Matches are counted from the message
 * text; the one in use is scrolled into view and highlighted where the browser
 * can paint a highlight.
 */
export function ConversationFindBar({ messages, root, onClose }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const textMatches = useMemo(() => findInMessages(messages, query), [messages, query])

  // Markdown syntax (`**`, link targets) is in the raw text but not on screen,
  // so the raw count can disagree with the highlights. Once the messages are
  // rendered, the DOM ranges are the truth; messages not rendered keep their
  // text count.
  const [domCounts, setDomCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    const host = root()
    const counts: Record<string, number> = {}
    if (host && query.trim()) {
      for (const m of messages) {
        const els = elementsOf(host, m.id)
        if (els.length) counts[m.id] = rangesInElements(els, query).length
      }
    }
    setDomCounts((prev) => {
      const a = Object.keys(counts)
      const same =
        a.length === Object.keys(prev).length && a.every((k) => prev[k] === counts[k])
      return same ? prev : counts
    })
  }, [messages, query, root])

  const matches = useMemo(() => {
    const textCount = new Map<string, number>()
    for (const m of textMatches) {
      textCount.set(m.messageId, (textCount.get(m.messageId) ?? 0) + 1)
    }
    const out: { messageId: string; ordinal: number }[] = []
    if (!query.trim()) return out
    for (const m of messages) {
      const n = domCounts[m.id] ?? textCount.get(m.id) ?? 0
      for (let i = 0; i < n; i++) out.push({ messageId: m.id, ordinal: i })
    }
    return out
  }, [messages, textMatches, domCounts, query])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // A new query starts from the first match.
  useEffect(() => setActive(0), [query])

  const count = matches.length
  const current = count > 0 ? matches[Math.min(active, count - 1)] : undefined

  const currentKey = current
    ? `${current.messageId}:${current.ordinal}:${query}`
    : ''

  // Scroll only when the match in use changes. The painting effect below
  // re-runs on every streamed token and must not pull the view back.
  useEffect(() => {
    const host = root()
    if (!host || !current) return
    const elements = elementsOf(host, current.messageId)
    if (elements.length === 0) return
    const ranges = rangesInElements(elements, query)
    const target = ranges[Math.min(current.ordinal, ranges.length - 1)]
    const anchor =
      (target?.startContainer.parentElement as HTMLElement | null) ??
      (elements[0] as HTMLElement)
    anchor.scrollIntoView?.({ block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey])

  useEffect(() => {
    const host = root()
    const highlights = registry()
    highlights?.delete(HIGHLIGHT_ALL)
    highlights?.delete(HIGHLIGHT_ACTIVE)
    if (!host || !current) return
    const elements = elementsOf(host, current.messageId)
    if (elements.length === 0) return
    const ranges = rangesInElements(elements, query)
    const target = ranges[Math.min(current.ordinal, ranges.length - 1)]
    const Highlight = (globalThis as { Highlight?: new (...r: Range[]) => unknown })
      .Highlight
    if (highlights && Highlight) {
      const everywhere = new Set<string>(messages.map((m) => m.id))
      const all: Range[] = []
      for (const id of everywhere) {
        all.push(...rangesInElements(elementsOf(host, id), query))
      }
      if (all.length) highlights.set(HIGHLIGHT_ALL, new Highlight(...all))
      if (target) highlights.set(HIGHLIGHT_ACTIVE, new Highlight(target))
    }
    return () => {
      highlights?.delete(HIGHLIGHT_ALL)
      highlights?.delete(HIGHLIGHT_ACTIVE)
    }
  }, [current, query, root, messages])

  const step = (dir: 1 | -1) => {
    if (count === 0) return
    setActive((i) => (Math.min(i, count - 1) + dir + count) % count)
  }

  return (
    <div
      role="search"
      data-testid="conversation-find-bar"
      className="absolute top-2 right-4 z-30 flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-md"
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={t('chat:find.placeholder')}
        aria-label={t('chat:find.placeholder')}
        data-testid="conversation-find-input"
        className="h-7 w-48 bg-transparent px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span
        data-testid="conversation-find-count"
        className="min-w-12 text-center text-xs text-muted-foreground tabular-nums"
      >
        {query.trim()
          ? count > 0
            ? `${Math.min(active, count - 1) + 1} / ${count}`
            : t('chat:find.none')
          : ''}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('chat:find.previous')}
        disabled={count === 0}
        onClick={() => step(-1)}
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('chat:find.next')}
        disabled={count === 0}
        onClick={() => step(1)}
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('chat:find.close')}
        onClick={onClose}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}
