import { useLayoutEffect, useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronsDownUpIcon, ChevronsUpDownIcon, WrapTextIcon } from 'lucide-react'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { isCodeBlockExpanded, setCodeBlockExpanded } from '@/lib/codeBlockExpand'

// Streamdown renders its code-block header itself (language, download, copy)
// and has no hook for extra controls, so the wrap toggle is portalled into the
// header's action group of every block inside `root`.
const ACTIONS_SELECTOR = '[data-streamdown="code-block-header"] > div:last-child'

function sameNodes(a: Element[], b: Element[]) {
  return a.length === b.length && a.every((el, i) => el === b[i])
}

export function WrapCodeLinesButton({ className }: { className?: string }) {
  const { t } = useTranslation()
  const wrap = useInterfaceSettings((s) => s.wrapCodeLines)
  const setWrap = useInterfaceSettings((s) => s.setWrapCodeLines)
  const label = t('settings:interface.wrapCodeLines')
  return (
    <button
      type="button"
      data-code-wrap-toggle=""
      aria-label={label}
      aria-pressed={wrap}
      title={label}
      onClick={() => setWrap(!wrap)}
      className={cn(
        'cursor-pointer rounded p-1 text-muted-foreground transition-colors duration-150 ease-expo hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
        className
      )}
    >
      <WrapTextIcon size={14} />
    </button>
  )
}

/**
 * Expand / collapse for a code block taller than the cap (see markdown.css).
 * Only shown when the body actually overflows; the choice is remembered per
 * block for the session.
 */
export function ExpandCodeBlockButton({ blockId }: { blockId: string }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLButtonElement>(null)
  const [expanded, setExpanded] = useState(() => isCodeBlockExpanded(blockId))
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const block = ref.current?.closest('[data-streamdown="code-block"]')
    const body = block?.querySelector<HTMLElement>('[data-streamdown="code-block-body"]')
    if (!block || !body) return
    if (expanded) block.setAttribute('data-code-expanded', '')
    else block.removeAttribute('data-code-expanded')
    const measure = () => {
      const capped = block.hasAttribute('data-code-expanded')
        ? body.scrollHeight > window.innerHeight * 0.6
        : body.scrollHeight > body.clientHeight + 1
      setOverflowing(capped)
      if (capped && !block.hasAttribute('data-code-expanded')) block.setAttribute('data-code-capped', '')
      else block.removeAttribute('data-code-capped')
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [expanded])

  const label = t(expanded ? 'common:collapse' : 'common:expand')
  return (
    <button
      ref={ref}
      type="button"
      data-code-expand-toggle=""
      aria-label={label}
      aria-expanded={expanded}
      hidden={!overflowing}
      onClick={() => {
        setCodeBlockExpanded(blockId, !expanded)
        setExpanded(!expanded)
      }}
      className="cursor-pointer rounded p-1 text-muted-foreground transition-colors duration-150 ease-expo hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      {expanded ? <ChevronsDownUpIcon size={14} /> : <ChevronsUpDownIcon size={14} />}
    </button>
  )
}

export function CodeWrapToggles({
  root,
  active,
  blockKey = 'md',
}: {
  root: RefObject<HTMLElement | null>
  active: boolean
  /** Prefix for remembering which blocks are expanded (the message id). */
  blockKey?: string
}) {
  const [targets, setTargets] = useState<Element[]>([])

  useEffect(() => {
    const el = root.current
    if (!active || !el) {
      setTargets((prev) => (prev.length ? [] : prev))
      return
    }
    const scan = () => {
      const found = Array.from(el.querySelectorAll(ACTIONS_SELECTOR))
      setTargets((prev) => (sameNodes(prev, found) ? prev : found))
    }
    scan()
    // Streamdown lazy-loads its CodeBlock, so headers appear after mount.
    const observer = new MutationObserver(scan)
    observer.observe(el, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [root, active])

  return (
    <>
      {targets.map((target, i) =>
        createPortal(
          <>
            <WrapCodeLinesButton />
            <ExpandCodeBlockButton blockId={`${blockKey}:${i}`} />
          </>,
          target,
          String(i)
        )
      )}
    </>
  )
}
