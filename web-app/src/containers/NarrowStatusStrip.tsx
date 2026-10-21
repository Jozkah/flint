/* eslint-disable react-refresh/only-export-components */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronDown,
  ChevronUp,
  FileDiff,
  GitBranch,
  Hand,
  ShieldQuestionIcon,
  Users,
} from 'lucide-react'
import { BarRowCompact } from '@/components/ui/bar-row'
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
  /** Other sessions share the folder: what the bar says, and whether it is urgent. */
  shared?: { label: string; urgent: boolean; count: number } | null
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
  const sharedEl = root.querySelector<HTMLElement>(
    '[data-testid="shared-folder-bar"]'
  )
  const shared = sharedEl
    ? {
        label: sharedEl.dataset.sharedLabel ?? '',
        urgent: sharedEl.dataset.sharedUrgent !== undefined,
        count: Number(sharedEl.dataset.sharedCount) || 0,
      }
    : null
  const filled = [...root.querySelectorAll<HTMLElement>('[data-bar-slot]')].filter(
    (slot) => slot.childElementCount > 0
  ).length
  return {
    trust: has('folder-trust-banner'),
    files,
    branch,
    more: Math.max(
      0,
      filled - (files ? 1 : 0) - (branch ? 1 : 0) - (shared ? 1 : 0)
    ),
    ...(shared ? { shared } : {}),
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
  /** A phone: the most urgent item with its words, and "+N" for the rest. */
  condensed?: boolean
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
  condensed = false,
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
    summary.trust ||
    summary.files ||
    summary.branch ||
    !!summary.shared ||
    summary.more > 0
  if (waiting <= 0 && !anyBar) return null
  const open = (e: MouseEvent) => {
    e.stopPropagation()
    onOpen()
  }
  type Chip = {
    id: string
    aria: string
    /** The words a condensed strip shows beside the first chip's icon. */
    label: string
    body: ReactNode
    className?: string
    onClick: (e: MouseEvent) => void
  }
  const chips: Chip[] = []
  if (waiting > 0)
    chips.push({
      id: 'waiting',
      aria: t('common:coworkStrip.waiting', { count: waiting }),
      label: t('common:waitingForYou'),
      body: (
        <>
          <Hand className="size-3.5" aria-hidden />
          {waiting}
        </>
      ),
      className: 'bg-warning/15 text-warning hover:bg-warning/25',
      onClick: (e) => {
        e.stopPropagation()
        onWaiting?.()
      },
    })
  if (summary.trust)
    chips.push({
      id: 'trust',
      aria: t('permissions:folderTrust.title'),
      label: t('permissions:folderTrust.trust'),
      body: <ShieldQuestionIcon className="size-3.5" aria-hidden />,
      className: 'text-warning',
      onClick: open,
    })
  const sharedChip: Chip | null = summary.shared
    ? {
        id: 'shared',
        aria: summary.shared.label,
        label: summary.shared.label,
        body: (
          <>
            <Users className="size-3.5" aria-hidden />
            {summary.shared.count}
          </>
        ),
        className: summary.shared.urgent ? 'text-warning' : undefined,
        onClick: open,
      }
    : null
  // An urgent shared-folder item ranks with the trust question; a calm one
  // goes last of the named chips.
  if (sharedChip && summary.shared?.urgent) chips.push(sharedChip)
  if (summary.files && files)
    chips.push({
      id: 'files',
      aria: t('common:coworkStrip.files', { count: files.count }),
      label: t('common:coworkReview.ready', { count: files.count }),
      body: (
        <>
          <FileDiff className="size-3.5" aria-hidden />
          {files.count}
          <span data-strip-diff="" hidden={tight} className="font-mono">
            <span className="text-diff-add">+{files.additions}</span>{' '}
            <span className="text-diff-del">−{files.deletions}</span>
          </span>
        </>
      ),
      onClick: open,
    })
  if (summary.branch)
    chips.push({
      id: 'branch',
      aria: t('common:coworkStrip.branch', { branch: branch ?? '' }),
      label: branch ?? '',
      body: <GitBranch className="size-3.5" aria-hidden />,
      onClick: open,
    })
  if (sharedChip && !summary.shared?.urgent) chips.push(sharedChip)
  // A condensed strip (a phone) shows the most urgent item with its words
  // and counts the rest; a wider one shows every chip.
  const shown = condensed ? chips.slice(0, 1) : chips
  const rest =
    (condensed ? chips.length - shown.length : 0) + summary.more
  return (
    <div
      role="group"
      aria-label={t('common:coworkStrip.label')}
      ref={rowRef}
      data-testid="narrow-status-strip"
      data-condensed={condensed ? '' : undefined}
      // The strip itself is a target too; its keyboard twin is the last button.
      onClick={anyBar ? onOpen : undefined}
      className="mb-1.5 flex h-9 min-w-0 items-center gap-0.5 overflow-hidden rounded-[10px] bg-muted px-1 shadow-[inset_0_0_0_0.8px_var(--border)] pointer-coarse:h-11"
    >
      {shown.map((c) => (
        <button
          key={c.id}
          type="button"
          data-testid={`strip-chip-${c.id}`}
          aria-label={c.aria}
          onClick={c.onClick}
          className={cn(CHIP, c.className)}
        >
          {c.body}
          {condensed && c.label && (
            <span className="font-sans">{c.label}</span>
          )}
        </button>
      ))}
      {rest > 0 && (
        <button
          type="button"
          data-testid="strip-chip-more"
          aria-label={t('common:coworkBars.showMore', { count: rest })}
          onClick={open}
          className={CHIP}
        >
          +{rest}
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
    (summary.shared ? 1 : 0) +
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
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  useLayoutEffect(() => {
    const target = open && host ? host : park
    if (target && el.parentNode !== target) target.appendChild(el)
  }, [open, host, park, el])

  const scan = useCallback(() => onSummary(summarizeBars(el)), [el, onSummary])
  useLayoutEffect(() => {
    scan()
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(scan)
    // The shared-folder bar changes what it says (a hold arrives) without
    // adding or removing a node: its data attributes are watched too.
    observer.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-shared-label',
        'data-shared-urgent',
        'data-shared-count',
      ],
    })
    return () => observer.disconnect()
  }, [el, scan])

  return (
    <>
      <div ref={setPark} hidden={!inline || open} />
      {createPortal(
        <BarRowCompact value={open}>{children}</BarRowCompact>,
        el
      )}
      {open && (
        <section
          data-testid="narrow-bars-sheet"
          aria-label={t('common:coworkStrip.label')}
          className="max-h-[50dvh] overflow-y-auto rounded-t-xl border-x border-t border-border bg-card px-3 pt-2 pb-2 motion-safe:animate-fade-in"
        >
          <div className="flex items-center justify-between pb-1.5">
            <span className="text-sm font-medium">{t('common:coworkStrip.label')}</span>
            <button
              type="button"
              data-testid="narrow-bars-close"
              aria-label={t('common:close')}
              onClick={() => onOpenChange(false)}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent"
            >
              <ChevronDown className="size-4" aria-hidden />
            </button>
          </div>
          <div ref={setHost} />
        </section>
      )}
    </>
  )
}
