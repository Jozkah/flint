/* eslint-disable react-refresh/only-export-components */
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronUp,
  FileDiff,
  GitBranch,
  Hand,
  ShieldQuestionIcon,
} from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

/** What the bars over the composer have on screen, read from the bars. */
export type NarrowBarsSummary = {
  /** The folder trust question is asked. */
  trust: boolean
  /** The "files ready for review" bar shows. */
  files: boolean
  /** The session's worktree bar shows. */
  branch: boolean
  /** Other bars that show (pull request, recovery, notices). */
  more: number
}

export const EMPTY_SUMMARY: NarrowBarsSummary = {
  trust: false,
  files: false,
  branch: false,
  more: 0,
}

/** Reads which bars a container holds; each bar decides whether it renders. */
export function summarizeBars(root: ParentNode): NarrowBarsSummary {
  const has = (id: string) => !!root.querySelector(`[data-testid="${id}"]`)
  const files = has('cowork-review-ready')
  const branch = has('session-worktree-bar')
  const filled = [...root.querySelectorAll<HTMLElement>('[data-bar-slot]')].filter(
    (slot) => slot.childElementCount > 0
  ).length
  return {
    trust: has('folder-trust-banner'),
    files,
    branch,
    more: Math.max(0, filled - (files ? 1 : 0) - (branch ? 1 : 0)),
  }
}

export type NarrowStatusStripProps = {
  /** Approvals waiting on the person in this session. */
  waiting: number
  summary: NarrowBarsSummary
  files?: { count: number; additions: number; deletions: number }
  branch?: string | null
  /** Takes the person to the waiting approval in the transcript. */
  onWaiting?: () => void
  /** Opens the sheet with the full bars. */
  onOpen: () => void
}

const CHIP =
  'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[length:calc(var(--ui-font-base)*0.75)] font-medium whitespace-nowrap text-secondary-foreground tabular-nums transition-colors hover:bg-hover-row focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:h-10 pointer-coarse:min-w-10 pointer-coarse:justify-center'

/**
 * The bars over the Cowork composer, summarised on a narrow screen as one row
 * of small chips in the order they need attention: waiting for you, trust the
 * folder, files to review, the worktree branch, anything else. Each chip
 * opens the sheet with the full bars; the waiting chip goes to the approval,
 * which stays in the transcript.
 */
export function NarrowStatusStrip({
  waiting,
  summary,
  files,
  branch,
  onWaiting,
  onOpen,
}: NarrowStatusStripProps) {
  const { t } = useTranslation()
  // The row never wraps: when its chips do not fit (a large interface font
  // on a phone), the line counts drop first, then come back with the room.
  const rowRef = useRef<HTMLDivElement>(null)
  const [tight, setTight] = useState(false)
  const diffWidth = useRef(0)
  useLayoutEffect(() => {
    const el = rowRef.current
    if (!el) return
    const fit = () => {
      const diff = el.querySelector<HTMLElement>('[data-strip-diff]')
      if (diff && diff.offsetWidth > 0) diffWidth.current = diff.offsetWidth + 4
      const over = el.scrollWidth > el.clientWidth + 1
      setTight((was) =>
        was ? el.scrollWidth + diffWidth.current > el.clientWidth : over
      )
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  })
  const anyBar =
    summary.trust || summary.files || summary.branch || summary.more > 0
  if (waiting <= 0 && !anyBar) return null
  const open = (e: MouseEvent) => {
    e.stopPropagation()
    onOpen()
  }
  return (
    <div
      role="group"
      aria-label={t('common:coworkStrip.label')}
      ref={rowRef}
      data-testid="narrow-status-strip"
      // The strip itself is a target too; its keyboard twin is the last button.
      onClick={anyBar ? onOpen : undefined}
      className="mb-1.5 flex h-9 min-w-0 items-center gap-0.5 overflow-hidden rounded-[10px] bg-muted px-1 shadow-[inset_0_0_0_0.8px_var(--border)] pointer-coarse:h-11"
    >
      {waiting > 0 && (
        <button
          type="button"
          data-testid="strip-chip-waiting"
          aria-label={t('common:coworkStrip.waiting', { count: waiting })}
          onClick={(e) => {
            e.stopPropagation()
            onWaiting?.()
          }}
          className={cn(CHIP, 'bg-warning/15 text-warning hover:bg-warning/25')}
        >
          <Hand className="size-3.5" aria-hidden />
          {waiting}
        </button>
      )}
      {summary.trust && (
        <button
          type="button"
          data-testid="strip-chip-trust"
          aria-label={t('permissions:folderTrust.title')}
          onClick={open}
          className={cn(CHIP, 'text-warning')}
        >
          <ShieldQuestionIcon className="size-3.5" aria-hidden />
        </button>
      )}
      {summary.files && files && (
        <button
          type="button"
          data-testid="strip-chip-files"
          aria-label={t('common:coworkStrip.files', { count: files.count })}
          onClick={open}
          className={CHIP}
        >
          <FileDiff className="size-3.5" aria-hidden />
          {files.count}
          <span data-strip-diff="" hidden={tight} className="font-mono">
            <span className="text-diff-add">+{files.additions}</span>{' '}
            <span className="text-diff-del">−{files.deletions}</span>
          </span>
        </button>
      )}
      {summary.branch && (
        <button
          type="button"
          data-testid="strip-chip-branch"
          aria-label={t('common:coworkStrip.branch', { branch: branch ?? '' })}
          onClick={open}
          className={CHIP}
        >
          <GitBranch className="size-3.5" aria-hidden />
        </button>
      )}
      {summary.more > 0 && (
        <button
          type="button"
          data-testid="strip-chip-more"
          aria-label={t('common:coworkBars.showMore', { count: summary.more })}
          onClick={open}
          className={CHIP}
        >
          +{summary.more}
        </button>
      )}
      {anyBar && (
        <button
          type="button"
          data-testid="strip-open"
          aria-label={t('common:coworkStrip.open')}
          onClick={open}
          className={cn(CHIP, 'ml-auto text-muted-foreground')}
        >
          <ChevronUp className="size-4" aria-hidden />
        </button>
      )}
    </div>
  )
}

/** How many things over the composer ask for attention. */
export function attentionCount(waiting: number, summary: NarrowBarsSummary): number {
  return (
    (waiting > 0 ? 1 : 0) +
    (summary.trust ? 1 : 0) +
    (summary.files ? 1 : 0) +
    (summary.branch ? 1 : 0) +
    summary.more
  )
}

/**
 * Keeps the bars mounted in one place for their whole life -- in place while
 * `inline`, otherwise parked out of sight, and moved into the sheet while it
 * is open -- so their own state survives and the strip can read what they
 * show.
 */
export function NarrowBarsSheet({
  open,
  inline = false,
  onOpenChange,
  onSummary,
  children,
}: {
  open: boolean
  /** Show the bars where they stand (one bar needs no strip). */
  inline?: boolean
  onOpenChange: (open: boolean) => void
  onSummary: (summary: NarrowBarsSummary) => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  const [el] = useState(() => {
    const div = document.createElement('div')
    div.setAttribute('data-testid', 'narrow-bars')
    return div
  })
  const [park, setPark] = useState<HTMLDivElement | null>(null)
  const [host, setHost] = useState<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const target = open && host ? host : park
    if (target && el.parentNode !== target) target.appendChild(el)
  }, [open, host, park, el])

  const scan = useCallback(() => onSummary(summarizeBars(el)), [el, onSummary])
  useLayoutEffect(() => {
    scan()
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(scan)
    observer.observe(el, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [el, scan])

  return (
    <>
      <div ref={setPark} hidden={!inline || open} />
      {createPortal(children, el)}
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          data-testid="narrow-bars-sheet"
          className="max-h-[80dvh] gap-0 overflow-y-auto rounded-t-xl pb-[max(env(safe-area-inset-bottom),12px)] sm:mx-auto sm:max-w-[780px] sm:border-x"
        >
          <SheetHeader className="pb-2">
            <SheetTitle>{t('common:coworkStrip.label')}</SheetTitle>
            <SheetDescription className="sr-only">
              {t('common:coworkStrip.open')}
            </SheetDescription>
          </SheetHeader>
          <div ref={setHost} className="px-3" />
        </SheetContent>
      </Sheet>
    </>
  )
}
