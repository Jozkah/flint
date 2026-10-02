import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Check,
  Copy,
  Link as LinkIcon,
  Lock,
  MessageSquarePlus,
  WrapText,
} from 'lucide-react'
import { codeToHtml, type ShikiTransformer } from 'shiki'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useTheme } from '@/hooks/useTheme'
import { tooHeavyToHighlight } from '@/lib/highlightLimits'
import {
  highlightKey,
  readHighlight,
  rememberHighlight,
} from '@/lib/highlightCache'
import {
  detectLanguage,
  isWritableOrigin,
  lineRangeOfSlice,
  type CodeRef,
  type FileOrigin,
} from '@/lib/coworkCode'

type CodeViewerProps = {
  /** Project-relative path, shown in the header and used for language detection. */
  relPath: string
  /** Verbatim file content. Never reformatted: what is on disk is what shows. */
  content: string
  /** Where the file lives. Travels onto any CodeRef the selection produces, so
   * the model is never told a sandbox file belongs to the user's project. */
  origin: FileOrigin
  wordWrap: boolean
  onToggleWrap: (next: boolean) => void
  /** When set, a selection offers “Add to chat” and reports the selected span. */
  onAddToChat?: (ref: CodeRef) => void
  className?: string
  changedLines?: Record<number, { added: boolean; removed: boolean }>
  /** Why this file cannot be edited, when editing exists for the session.
   * Replaces the generic read-only tooltip. */
  readOnlyHint?: string
  /** Bring this 1-based line into view; `at` repeats a request. */
  revealLine?: { line: number; at: number } | null
}

/** Same line-number transformer style as `ai-elements/code-block`, kept local so
 * the viewer and the chat block can diverge (gutter is unselectable here). */
const lineNumbers = (changedLines: CodeViewerProps['changedLines']): ShikiTransformer => ({
  name: 'code-viewer-line-numbers',
  line(node, line) {
    // Stamped on the line itself so a selection can be mapped back to a line
    // number by structure. Reading it off the DOM beats searching the text
    // for the selected string, which lands on the wrong line whenever the
    // selection is not unique — `}` or `return` matches the first one.
    node.properties = { ...node.properties, 'data-cv-line': String(line) }
    node.children.unshift({
      type: 'element',
      tagName: 'span',
      properties: {
        className: [
          'cv-line-no',
          'select-none',
          'inline-block',
          'min-w-8',
          'mr-4',
          'text-right',
          'text-subtle-foreground',
        ],
        'aria-hidden': 'true',
      },
      children: [{ type: 'text', value: String(line) }],
    })
    const marker = changedLines?.[line]
    if (marker) {
      node.children.unshift({
        type: 'element',
        tagName: 'span',
        properties: {
          className: ['cv-change-marker', 'inline-block', 'min-w-5', 'select-none'],
          'aria-label': marker.added && marker.removed ? 'Changed line' : marker.added ? 'Added line' : 'Removed line',
        },
        children: [
          ...(marker.removed ? [{ type: 'element' as const, tagName: 'span', properties: { className: ['text-destructive'] }, children: [{ type: 'text' as const, value: '−' }] }] : []),
          ...(marker.added ? [{ type: 'element' as const, tagName: 'span', properties: { className: ['text-success'] }, children: [{ type: 'text' as const, value: '+' }] }] : []),
        ],
      })
    }
  },
})

/** 1-based line number of the rendered line containing `node`, if any. */
function lineOfNode(node: Node | null): number | null {
  let element =
    node instanceof Element ? node : (node?.parentElement ?? null)
  while (element && !element.hasAttribute('data-cv-line')) {
    element = element.parentElement
  }
  if (!element) return null
  const line = Number(element.getAttribute('data-cv-line'))
  return Number.isFinite(line) && line > 0 ? line : null
}

/**
 * Read-only source viewer: Shiki highlighting in the active Flint theme, line numbers,
 * horizontal scrolling, optional word wrap, copy actions and selection →
 * “Add to chat”. The content is displayed exactly as read — no formatter runs.
 */
export function CodeViewer({
  relPath,
  content,
  origin,
  wordWrap,
  onToggleWrap,
  onAddToChat,
  className,
  changedLines,
  readOnlyHint,
  revealLine,
}: CodeViewerProps) {
  const { t } = useTranslation()
  const language = useMemo(() => detectLanguage(relPath), [relPath])
  const isDark = useTheme((s) => s.isDark)
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState<'code' | 'path' | null>(null)
  const [selection, setSelection] = useState<CodeRef | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Tokenising a huge or minified file blocks the renderer for seconds and
  // balloons the DOM; past these bounds the plain source is shown instead.
  const plainOnly = useMemo(() => tooHeavyToHighlight(content), [content])

  useEffect(() => {
    if (plainOnly) {
      setHtml(null)
      return
    }
    let alive = true
    const theme = isDark ? 'one-dark-pro' : 'one-light'
    const markers = JSON.stringify(changedLines ?? {})
    const cacheKey = `${highlightKey(content, language.lang, theme)}:${markers}`
    const cached = readHighlight(cacheKey)
    if (cached) {
      setHtml(cached)
      return
    }
    // Only the theme actually on screen is tokenised. Highlighting both and
    // hiding one with CSS doubled the work on every open for output nobody
    // ever saw.
    setHtml(null)
    void codeToHtml(content, {
      lang: language.lang,
      theme,
      transformers: [lineNumbers(changedLines)],
    })
      .then((markup) => {
        rememberHighlight(cacheKey, markup)
        if (alive) setHtml(markup)
      })
      .catch(() => {
        // A grammar failure falls back to the plaintext <pre> below; the file
        // still shows, just uncolored.
      })
    return () => {
      alive = false
    }
  }, [content, language.lang, isDark, relPath, changedLines, plainOnly])

  // Scroll to a requested line once the highlighted lines exist, and mark it
  // briefly so the eye lands on it.
  useEffect(() => {
    if (!revealLine || !html) return
    const row = bodyRef.current?.querySelector<HTMLElement>(
      `[data-cv-line="${revealLine.line}"]`
    )
    if (!row) return
    row.scrollIntoView?.({ block: 'center' })
    row.setAttribute('data-cv-revealed', 'true')
    const timer = setTimeout(() => row.removeAttribute('data-cv-revealed'), 1600)
    return () => clearTimeout(timer)
    // Keyed on the request's fields: a new object for the same request must
    // not scroll the reader back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealLine?.line, revealLine?.at, html])

  const copy = useCallback(
    async (what: 'code' | 'path') => {
      try {
        await navigator.clipboard.writeText(what === 'code' ? content : relPath)
        setCopied(what)
        setTimeout(() => setCopied(null), 2000)
      } catch {
        // Clipboard unavailable; the button simply does nothing visible.
      }
    },
    [content, relPath]
  )

  /** Map the DOM selection back to content offsets. The gutter is
   * `select-none`, so `toString()` returns source text only. */
  const handleMouseUp = useCallback(() => {
    if (!onAddToChat) return
    const sel = window.getSelection()
    const container = bodyRef.current
    if (!sel || sel.isCollapsed || !container) {
      setSelection(null)
      return
    }
    if (
      !container.contains(sel.anchorNode) ||
      !container.contains(sel.focusNode)
    ) {
      setSelection(null)
      return
    }
    const text = sel.toString()
    if (!text.trim()) {
      setSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    const from = lineOfNode(range.startContainer)
    // A selection dragged past the end of a line stops at offset 0 of the
    // next one, which contributes no character and must not be counted.
    const rawTo = lineOfNode(range.endContainer)
    const to =
      rawTo !== null && range.endOffset === 0 && rawTo > (from ?? rawTo)
        ? rawTo - 1
        : rawTo

    let startLine: number
    let endLine: number
    if (from !== null && to !== null) {
      startLine = Math.min(from, to)
      endLine = Math.max(from, to)
    } else {
      // No highlighted lines to read: Shiki has not resolved yet, so the
      // plain <pre> is showing. Offsets are only trustworthy when the
      // selected text appears exactly once — otherwise report nothing rather
      // than a wrong range.
      const start = content.indexOf(text)
      if (start < 0 || content.indexOf(text, start + 1) >= 0) {
        setSelection(null)
        return
      }
      const fallback = lineRangeOfSlice(content, start, start + text.length)
      startLine = fallback.startLine
      endLine = fallback.endLine
    }
    setSelection({ path: relPath, origin, startLine, endLine, code: text })
  }, [content, onAddToChat, relPath, origin])

  const iconButton = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    pressed?: boolean
  ) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClick}
          aria-label={label}
          aria-pressed={pressed}
          className={cn(
            'shrink-0 pointer-coarse:size-11',
            pressed ? 'bg-accent text-foreground' : 'text-muted-foreground'
          )}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )

  const preClasses = cn(
    '[&_[data-cv-revealed]]:bg-acc-tint [&>pre]:m-0 [&>pre]:bg-transparent! [&>pre]:px-2 [&>pre]:py-3 [&>pre]:text-xs [&>pre]:leading-[1.6] [&_code]:font-mono [&_code]:text-xs',
    wordWrap
      ? '[&>pre]:whitespace-pre-wrap [&>pre]:break-words'
      : // Unwrapped, the block is as wide as its longest line (and never
        // narrower than the pane), so the scroller reaches the end of every
        // line instead of the highlighted block stopping at the pane's edge.
        '[&>pre]:w-max [&>pre]:min-w-full [&>pre]:overflow-visible [&>pre]:whitespace-pre'
  )

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col', className)}>
      <div className="flex h-10 shrink-0 items-center gap-1 px-3 pointer-coarse:h-11">
        {/* Truthful about capability: this surface never writes. */}
        {(readOnlyHint !== undefined || !isWritableOrigin(origin)) && (
          <span
            className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-md border-[0.8px] border-border bg-card px-2 text-[11px] font-medium text-secondary-foreground"
            title={readOnlyHint ?? t('common:codePanel.readOnlyHint')}
            data-testid="code-readonly-badge"
          >
            <Lock className="size-3" aria-hidden />
            {t('common:codePanel.readOnly')}
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate px-1 font-mono text-[11px] text-muted-foreground"
          title={relPath}
        >
          {relPath}
        </span>
        <span className="shrink-0 pr-1 text-[11px] text-subtle-foreground">
          {language.label}
        </span>
        {iconButton(
          t('common:codePanel.toggleWrap'),
          <WrapText className="size-3.5" />,
          () => onToggleWrap(!wordWrap),
          wordWrap
        )}
        {iconButton(
          t('common:codePanel.copyPath'),
          copied === 'path' ? (
            <Check className="size-3.5" />
          ) : (
            <LinkIcon className="size-3.5" />
          ),
          () => void copy('path')
        )}
        {iconButton(
          t('common:codePanel.copyCode'),
          copied === 'code' ? (
            <Check className="size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          ),
          () => void copy('code')
        )}
      </div>

      <div
        ref={bodyRef}
        role="region"
        aria-label={relPath}
        tabIndex={0}
        onMouseUp={handleMouseUp}
        onKeyUp={handleMouseUp}
        // The code surface scrolls both ways inside itself; long lines never
        // widen the panel or the page.
        className="relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain border-t border-dashed border-border bg-code-bg outline-none [scrollbar-width:thin] focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset"
        data-testid="code-viewer-body"
      >
        {html ? (
          <div
            className={preClasses}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          // Highlighting is async; the raw source shows immediately so a big
          // file never presents an empty pane.
          <pre
            className={cn(
              'm-0 px-3 py-3 font-mono text-xs leading-[1.6]',
              wordWrap
                ? 'whitespace-pre-wrap break-words'
                : 'w-max min-w-full whitespace-pre'
            )}
          >
            {content}
          </pre>
        )}

        {selection && onAddToChat && (
          <div className="sticky bottom-2 left-2 z-10 inline-flex">
            <Button
              size="sm"
              variant="surface"
              className="shadow-pop"
              // The button sits inside the region that watches for selection
              // changes. Without this, pressing it collapses the selection,
              // the mouseup that follows clears `selection`, the button
              // unmounts mid-gesture and the click never lands — the action
              // is simply unclickable. Suppressing the default mousedown
              // keeps the selection alive until onClick has run.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onAddToChat(selection)
                setSelection(null)
                window.getSelection()?.removeAllRanges()
              }}
            >
              <MessageSquarePlus className="mr-1 size-3.5" />
              {t('common:codePanel.addToChat', {
                range:
                  selection.startLine === selection.endLine
                    ? `L${selection.startLine}`
                    : `L${selection.startLine}-${selection.endLine}`,
              })}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
