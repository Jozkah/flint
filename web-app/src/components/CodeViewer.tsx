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
import {
  detectLanguage,
  lineRangeOfSlice,
  type CodeRef,
} from '@/lib/coworkCode'

type CodeViewerProps = {
  /** Project-relative path, shown in the header and used for language detection. */
  relPath: string
  /** Verbatim file content. Never reformatted: what is on disk is what shows. */
  content: string
  wordWrap: boolean
  onToggleWrap: (next: boolean) => void
  /** When set, a selection offers “Add to chat” and reports the selected span. */
  onAddToChat?: (ref: CodeRef) => void
  className?: string
}

/** Same line-number transformer style as `ai-elements/code-block`, kept local so
 * the viewer and the chat block can diverge (gutter is unselectable here). */
const lineNumbers: ShikiTransformer = {
  name: 'code-viewer-line-numbers',
  line(node, line) {
    node.children.unshift({
      type: 'element',
      tagName: 'span',
      properties: {
        className: [
          'cv-line-no',
          'select-none',
          'inline-block',
          'min-w-10',
          'mr-4',
          'text-right',
          'text-muted-foreground',
        ],
        'aria-hidden': 'true',
      },
      children: [{ type: 'text', value: String(line) }],
    })
  },
}

/**
 * Read-only source viewer: Shiki highlighting in both Jan themes, line numbers,
 * horizontal scrolling, optional word wrap, copy actions and selection →
 * “Add to chat”. The content is displayed exactly as read — no formatter runs.
 */
export function CodeViewer({
  relPath,
  content,
  wordWrap,
  onToggleWrap,
  onAddToChat,
  className,
}: CodeViewerProps) {
  const { t } = useTranslation()
  const language = useMemo(() => detectLanguage(relPath), [relPath])
  const [html, setHtml] = useState<string | null>(null)
  const [darkHtml, setDarkHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState<'code' | 'path' | null>(null)
  const [selection, setSelection] = useState<CodeRef | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    setHtml(null)
    setDarkHtml(null)
    const opts = { lang: language.lang, transformers: [lineNumbers] }
    void Promise.all([
      codeToHtml(content, { ...opts, theme: 'one-light' }),
      codeToHtml(content, { ...opts, theme: 'one-dark-pro' }),
    ])
      .then(([light, dark]) => {
        if (!alive) return
        setHtml(light)
        setDarkHtml(dark)
      })
      .catch(() => {
        // A grammar failure falls back to the plaintext <pre> below; the file
        // still shows, just uncolored.
      })
    return () => {
      alive = false
    }
  }, [content, language.lang])

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
    const start = content.indexOf(text)
    if (start < 0) {
      // Rendering split the selection in a way we cannot map back; offer
      // nothing rather than a wrong range.
      setSelection(null)
      return
    }
    const { startLine, endLine } = lineRangeOfSlice(
      content,
      start,
      start + text.length
    )
    setSelection({ path: relPath, startLine, endLine, code: text })
  }, [content, onAddToChat, relPath])

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
            'shrink-0',
            pressed ? 'text-primary' : 'text-muted-foreground'
          )}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )

  const preClasses = cn(
    '[&>pre]:m-0 [&>pre]:bg-transparent! [&>pre]:p-3 [&>pre]:text-xs [&_code]:font-mono [&_code]:text-xs',
    wordWrap
      ? '[&>pre]:whitespace-pre-wrap [&>pre]:break-words'
      : '[&>pre]:whitespace-pre'
  )

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-main-view-fg/70"
          title={relPath}
        >
          {relPath}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
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
        className="relative min-h-0 flex-1 overflow-auto focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
        data-testid="code-viewer-body"
      >
        {html && darkHtml ? (
          <>
            <div
              className={cn('dark:hidden', preClasses)}
              dangerouslySetInnerHTML={{ __html: html }}
            />
            <div
              className={cn('hidden dark:block', preClasses)}
              dangerouslySetInnerHTML={{ __html: darkHtml }}
            />
          </>
        ) : (
          // Highlighting is async; the raw source shows immediately so a big
          // file never presents an empty pane.
          <pre
            className={cn(
              'm-0 p-3 font-mono text-xs',
              wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
            )}
          >
            {content}
          </pre>
        )}

        {selection && onAddToChat && (
          <div className="sticky bottom-2 left-2 z-10 inline-flex">
            <Button
              size="sm"
              variant="secondary"
              className="shadow-md"
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
