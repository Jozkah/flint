/* eslint-disable react-refresh/only-export-components */
import { useState, type ReactNode } from 'react'
import { ChevronRight, GitBranch, GitFork } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { ModelAvatar } from '@/containers/ModelAvatar'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getServiceHub } from '@/hooks/useServiceHub'
import { cn } from '@/lib/utils'
import { splitTitleTail } from '@/lib/titleTail'
import type { PrState, PrStatus } from '@/stores/pr-status-store'

/** How long the pointer rests on a row before its preview card opens. */
export const PREVIEW_OPEN_DELAY = 500
export const PREVIEW_CLOSE_DELAY = 100

/**
 * The card's classes: content-fit between 18 and 24rem for chats, sessions
 * and rooms, never taller than the viewport (an unfolded pull-request list
 * scrolls inside instead). Sections pad themselves, so the card itself has
 * none.
 */
export const PREVIEW_CARD_CLASS =
  'w-max min-w-[18rem] max-w-[min(24rem,calc(100vw-2rem))] max-h-[min(calc(100vh-2rem),var(--radix-hover-card-content-available-height))] overflow-x-hidden overflow-y-auto p-0'

/** Pull requests listed before the rest fold behind "+N more". */
export const PREVIEW_PR_LIMIT = 5

/** What the row is doing now, as the chip in the card's corner says it. */
export type PreviewStatus = 'running' | 'waiting' | 'idle' | 'error'

export type PreviewMeta = {
  /**
   * Where the work is: the folder's last segments (`acme-weather`, `web`) or
   * a project's name, shown as a breadcrumb.
   */
  place?: string[]
  /** The worktree branch, when the row works in one. */
  branch?: string
  /** The model's display name. */
  model?: string
  /** Which model and provider that is, for its mark. */
  modelRef?: { provider: string; id: string }
  /** Last active, epoch milliseconds. */
  updated?: number
  /** How many messages the conversation holds; left out when unknown. */
  messages?: number
}

const lang = () =>
  (typeof document !== 'undefined' && document.documentElement.lang) ||
  undefined

/**
 * "Today, 23:36", "Yesterday, 10:18", "Mon, 10:18" within the week, else
 * "Oct 3, 10:18". Short enough to sit on one line under the title.
 */
export function formatPreviewTime(ms: number, now = new Date()): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(lang(), {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const day = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(now) - day(d)) / 86_400_000)
  const relative = new Intl.RelativeTimeFormat(lang(), { numeric: 'auto' })
  let when: string
  if (days <= 0) when = relative.format(0, 'day')
  else if (days === 1) when = relative.format(-1, 'day')
  else if (days < 7) when = d.toLocaleDateString(lang(), { weekday: 'short' })
  else when = d.toLocaleDateString(lang(), { month: 'short', day: 'numeric' })
  return `${when.charAt(0).toUpperCase()}${when.slice(1)}, ${time}`
}

/**
 * "just now", "5 min ago", "3 hr ago", "6 days ago"; undefined once it is a
 * week old, when the date in `formatPreviewTime` says it better. The short
 * units come without their abbreviation period ("min." is "min").
 */
export function formatRelativeTime(ms: number, now = Date.now()): string | undefined {
  const ago = Math.max(0, now - ms)
  const rtf = new Intl.RelativeTimeFormat(lang(), { numeric: 'auto', style: 'short' })
  const plain = (s: string) => s.replace(/\.(?=\s|$)/g, '')
  if (ago < 60_000) return rtf.format(0, 'second').replace(/^\w/, (c) => c.toUpperCase())
  if (ago < 3_600_000) return plain(rtf.format(-Math.round(ago / 60_000), 'minute'))
  if (ago < 86_400_000) return plain(rtf.format(-Math.round(ago / 3_600_000), 'hour'))
  if (ago < 7 * 86_400_000) return plain(rtf.format(-Math.round(ago / 86_400_000), 'day'))
  return undefined
}

/** `owner/name` from a GitHub pull request URL, else undefined. */
export function prRepo(url: string): string | undefined {
  return /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1]
}

const STATUS_TONE: Record<PreviewStatus, 'info' | 'warn' | 'neutral' | 'err'> = {
  running: 'info',
  waiting: 'warn',
  idle: 'neutral',
  error: 'err',
}

const PR_TONE: Record<PrState, 'ok' | 'neutral' | 'merged' | 'err'> = {
  open: 'ok',
  draft: 'neutral',
  merged: 'merged',
  closed: 'err',
}

/** The PR number's colour, as the pull-request bar colours it. */
const PR_NUMBER: Record<PrState, string> = {
  open: 'text-foreground',
  draft: 'text-muted-foreground',
  merged: 'text-merged',
  closed: 'text-destructive',
}

const fmt = (n: number) => n.toLocaleString(lang())

const Dot = ({ className }: { className: string }) => (
  <i aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full', className)} />
)

/** The checks of one pull request: a dot and count per verdict, or a word. */
function PrChecks({ pr }: { pr: PrStatus }) {
  const { t } = useTranslation()
  if (pr.statusError) {
    return (
      <span
        data-testid="preview-pr-error"
        className="truncate text-destructive"
        title={pr.statusError}
      >
        {t('common:pr.statusUnavailable')}
      </span>
    )
  }
  // Recorded but its status not read (not yet, or never): said plainly, in a
  // muted tone, rather than "no checks" or a placeholder that may stay.
  if (!pr.title) {
    return (
      <span data-testid="preview-pr-status-pending" className="text-subtle-foreground">
        {t('common:pr.statusUnavailable')}
      </span>
    )
  }
  const { passed, failed, pending } = pr.checks
  if (passed + failed + pending === 0) {
    return (
      <span data-testid="preview-pr-nochecks" className="text-subtle-foreground">
        {t('common:rowPreview.noChecks')}
      </span>
    )
  }
  const parts: { n: number; cls: string; label: string; key: string }[] = [
    { key: 'failed', n: failed, cls: 'bg-destructive', label: t('common:pr.failed', { count: failed }) },
    { key: 'pending', n: pending, cls: 'bg-warning motion-safe:animate-pulse', label: t('common:pr.pending', { count: pending }) },
    { key: 'passed', n: passed, cls: 'bg-success', label: t('common:pr.passed', { count: passed }) },
  ]
  return (
    <span
      data-testid="preview-pr-checks"
      className="inline-flex items-center gap-2 tabular-nums"
      title={parts.filter((p) => p.n > 0).map((p) => p.label).join(' · ')}
    >
      {parts
        .filter((p) => p.n > 0)
        .map((p) => (
          <span key={p.key} data-verdict={p.key} className="inline-flex items-center gap-1">
            <Dot className={p.cls} />
            {p.n}
          </span>
        ))}
    </span>
  )
}

/** One pull request: state, repository and number, size; title; branch and checks. */
function PrRow({ pr }: { pr: PrStatus }) {
  const { t } = useTranslation()
  const repo = prRepo(pr.url)
  return (
    <li data-testid="preview-pr" data-state={pr.state}>
      {/* A real link, so keyboard focus can reach the row (ArrowRight from the
          sidebar row); the app's opener sends it to the browser. */}
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        data-testid="preview-pr-link"
        onClick={(e) => {
          e.preventDefault()
          void getServiceHub().opener().openUrl(pr.url)
        }}
        className="flex flex-col gap-0.5 px-3 py-1.5 text-[11px] leading-4 outline-hidden hover:bg-hover-row focus-visible:bg-hover-row focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset"
      >
      <div className="flex min-w-0 items-center gap-1.5">
        <Chip tone={PR_TONE[pr.state]} dot className="h-[18px] px-1.5 text-[10px]">
          {t(`common:rowPreview.prState.${pr.state}`)}
        </Chip>
        <span className="min-w-0 truncate text-muted-foreground">
          {repo && <span className="text-subtle-foreground">{repo} </span>}
          <span className={cn('font-medium', PR_NUMBER[pr.state])}>#{pr.number}</span>
        </span>
        <span className="flex-1" />
        {(pr.additions > 0 || pr.deletions > 0) && (
          <span className="shrink-0 font-mono tabular-nums">
            <span className="text-success">+{fmt(pr.additions)}</span>{' '}
            <span className="text-destructive">−{fmt(pr.deletions)}</span>
          </span>
        )}
      </div>
      {/* The title arrives with the status; until then (or without one) the
          branch names the pull request, in the title's place. */}
      <p
        data-testid="preview-pr-title"
        className={cn('truncate text-xs text-foreground', !pr.title && 'font-mono')}
        title={pr.title || pr.head || undefined}
      >
        {pr.title || pr.head || `#${pr.number}`}
      </p>
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        {pr.head && pr.title && (
          <span className="inline-flex min-w-0 items-center gap-1 font-mono" title={pr.head}>
            <GitBranch className="size-3 shrink-0 text-subtle-foreground" aria-hidden />
            <span className="truncate">{pr.head}</span>
          </span>
        )}
        <span className="flex-1" />
        <PrChecks pr={pr} />
      </div>
      </a>
    </li>
  )
}

/**
 * The pull requests a row opened: every one, latest first, the first few in
 * full and the rest behind "+N more" (which unfolds them in place). Nothing
 * while there are none and nothing is being looked up.
 */
export function PreviewPullRequests({
  prs,
  loading,
  error,
}: {
  prs: PrStatus[]
  /** A lookup is in flight and nothing is known yet. */
  loading?: boolean
  /** Why the list could not be read; shown instead of an empty list. */
  error?: string
}) {
  const { t } = useTranslation()
  const [all, setAll] = useState(false)
  if (prs.length === 0 && !loading && !error) return null
  const shown = all ? prs : prs.slice(0, PREVIEW_PR_LIMIT)
  const hidden = prs.length - shown.length
  return (
    <section
      data-testid="preview-prs"
      aria-label={t('common:rowPreview.pullRequests')}
      className="border-t border-border/70 pb-1"
    >
      <header className="flex items-center gap-2 px-3 pt-2 pb-0.5 text-[10px] font-medium tracking-wide text-subtle-foreground uppercase">
        {t('common:rowPreview.pullRequests')}
        {prs.length > 0 && (
          <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums normal-case">
            {prs.length}
          </span>
        )}
      </header>
      {prs.length === 0 ? (
        loading ? (
          <div data-testid="preview-prs-loading" className="flex flex-col gap-1.5 px-3 py-2">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        ) : (
          <p data-testid="preview-prs-error" className="px-3 py-1.5 text-[11px] text-muted-foreground" title={error}>
            {t('common:pr.statusUnavailable')}
          </p>
        )
      ) : (
        <ul className="divide-y divide-border/50">
          {shown.map((pr) => (
            <PrRow key={pr.url} pr={pr} />
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button
          type="button"
          data-testid="preview-prs-more"
          className="mx-3 mb-0.5 cursor-pointer text-[11px] text-info hover:underline"
          onClick={() => setAll(true)}
        >
          {t('common:rowPreview.morePrs', { count: hidden })}
        </button>
      )}
    </section>
  )
}

/**
 * The peek at a sidebar row: its title and state, where and on what it
 * works, when it was last active and how long it is, what it is about, and
 * the pull requests it opened. One card for chats, Cowork sessions and rooms.
 */
export function PreviewCard({
  title,
  status = 'idle',
  meta,
  summary,
  summaryLoading,
  pullRequests,
  hint,
}: {
  title: string
  status?: PreviewStatus
  meta?: PreviewMeta
  /** What it is about; the empty state is shown without one. */
  summary?: string
  /** A written summary is being made; `summary` is the plain line meanwhile. */
  summaryLoading?: boolean
  /** The pull-request section, rendered by the caller so its lookups run only while the card is open. */
  pullRequests?: ReactNode
  /** A keyboard hint in the footer, e.g. when the card opened from focus. */
  hint?: boolean
}) {
  const { t } = useTranslation()
  // A fork says so with a mark of its own, as a pull request does, not with a
  // "(fork)" tail on the title.
  const [titleHead, titleTail] = splitTitleTail(title)
  const isFork = titleTail.trim() === '(fork)'
  const shownTitle = isFork ? titleHead : title
  const relative = meta?.updated ? formatRelativeTime(meta.updated) : undefined
  const absolute = meta?.updated ? formatPreviewTime(meta.updated) : undefined
  const place = meta?.place?.filter(Boolean) ?? []
  // A summary that only repeats the title says nothing: the empty state instead.
  const about = summary?.trim() === title.trim() || summary?.trim() === shownTitle.trim() ? undefined : summary
  const facts: ReactNode[] = []
  if (meta?.model)
    facts.push(
      <span key="model" className="inline-flex min-w-0 items-center gap-1.5">
        <ModelAvatar
          modelId={meta.modelRef?.id ?? meta.model}
          name={meta.model}
          provider={meta.modelRef?.provider}
          size={14}
        />
        <span className="truncate">{meta.model}</span>
      </span>
    )
  if (absolute)
    facts.push(
      <time
        key="time"
        data-testid="row-preview-time"
        dateTime={new Date(meta!.updated!).toISOString()}
        title={new Date(meta!.updated!).toLocaleString(lang())}
        className="shrink-0 tabular-nums"
      >
        {relative ? `${relative} · ${absolute}` : absolute}
      </time>
    )
  if (typeof meta?.messages === 'number' && meta.messages > 0)
    facts.push(
      <span key="count" data-testid="row-preview-count" className="shrink-0 tabular-nums">
        {t('common:previewMessageCount', { count: meta.messages })}
      </span>
    )
  return (
    <div data-testid="row-preview-card" className="flex flex-col">
      <header className="flex flex-col gap-1 px-3 pt-2.5 pb-2">
        <div className="flex items-start gap-2">
          <p
            data-testid="row-preview-title"
            className="line-clamp-2 min-w-0 flex-1 break-words text-[0.8125rem] leading-snug font-medium text-foreground"
          >
            {shownTitle}
          </p>
          {isFork && (
            <Chip
              data-testid="row-preview-fork"
              tone="neutral"
              className="mt-px h-[18px] shrink-0 gap-1 px-1.5 text-[10px]"
            >
              <GitFork className="size-2.5" aria-hidden />
              {t('chat:fork.chat')}
            </Chip>
          )}
          {status !== 'idle' && (
            <Chip
              data-testid="row-preview-status"
              data-status={status}
              tone={STATUS_TONE[status]}
              dot
              live={status === 'running'}
              className="mt-px"
            >
              {t(`common:rowPreview.status.${status}`)}
            </Chip>
          )}
        </div>
        {(place.length > 0 || meta?.branch) && (
          <p
            data-testid="row-preview-place"
            className="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground"
          >
            {place.map((seg, i) => (
              <span key={`${seg}-${i}`} className="inline-flex min-w-0 items-center gap-1">
                {i > 0 && <ChevronRight className="size-2.5 shrink-0 text-subtle-foreground" aria-hidden />}
                <span className={cn('truncate', i === place.length - 1 && 'text-secondary-foreground')}>{seg}</span>
              </span>
            ))}
            {meta?.branch && (
              <span className="inline-flex min-w-0 items-center gap-1 font-mono" title={meta.branch}>
                {place.length > 0 && <span className="text-subtle-foreground">·</span>}
                <GitBranch className="size-2.5 shrink-0 text-subtle-foreground" aria-hidden />
                <span className="truncate">{meta.branch}</span>
              </span>
            )}
          </p>
        )}
        {facts.length > 0 && (
          <p
            data-testid="row-preview-meta"
            className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-subtle-foreground"
          >
            {facts.map((f, i) => (
              <span key={i} className="inline-flex min-w-0 items-center gap-1.5">
                {i > 0 && <span aria-hidden>·</span>}
                {f}
              </span>
            ))}
          </p>
        )}
      </header>
      <div className="border-t border-border/70 px-3 py-2">
        {about ? (
          <p
            data-testid="row-preview-summary"
            className={cn(
              'line-clamp-4 text-xs leading-relaxed break-words text-secondary-foreground [mask-image:linear-gradient(to_bottom,#000_75%,transparent)]',
              summaryLoading && 'opacity-60'
            )}
          >
            {about}
          </p>
        ) : (
          <p data-testid="row-preview-empty" className="text-xs leading-relaxed text-subtle-foreground italic">
            {summaryLoading
              ? t('common:rowPreview.summarizing')
              : meta?.messages === 0
                ? t('common:rowPreview.noMessages')
                : t('common:rowPreview.empty')}
          </p>
        )}
      </div>
      {pullRequests}
      {hint && (
        <footer
          data-testid="row-preview-hint"
          className="flex items-center gap-1.5 border-t border-border/70 bg-muted/40 px-3 py-1.5 text-[11px] text-subtle-foreground"
        >
          <Kbd>↵</Kbd>
          {t('common:rowPreview.openHint')}
        </footer>
      )}
    </div>
  )
}
