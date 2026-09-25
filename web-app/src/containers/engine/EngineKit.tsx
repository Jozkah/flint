import type { ReactNode } from 'react'
import { CountUp } from '@/components/ui/count-up'
import {
  Atom,
  Binary,
  Eye,
  Globe,
  Headphones,
  Search,
  Wrench,
} from 'lucide-react'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { cn } from '@/lib/utils'

/**
 * Page title block for the engine pages (Models, Tools & MCP, Extensions,
 * Library): a 24px title, a one-line description, and the page's actions at
 * the end of the row. The top header's breadcrumb names the area; this names
 * what the page is for.
 */
export function PageHead({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-4 leading-none motion-safe:animate-rise-in">
        <h1 className="text-2xl leading-none font-medium tracking-[-0.01em] text-foreground">
          {title}
        </h1>
        {description && (
          <p className="m-0 text-[13px] leading-snug text-secondary-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 motion-safe:animate-rise-in [animation-delay:60ms] max-sm:w-full">
          {actions}
        </div>
      )}
    </div>
  )
}

/** The scrolling page body: `.page` padding and the 24px `.stack` rhythm. */
export function EnginePage({
  children,
  testId,
  className,
}: {
  children: ReactNode
  testId?: string
  className?: string
}) {
  return (
    <div className="h-full min-h-0 w-full min-w-0 overflow-x-hidden overflow-y-auto">
      <div
        data-testid={testId}
        className={cn(
          'mx-auto flex w-full max-w-[1800px] min-w-0 flex-col gap-6 px-1 pt-4 pb-[calc(2rem+env(safe-area-inset-bottom))]',
          className
        )}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * A KPI tile (the design's `.kcard`): title and icon on the frame, a large
 * figure and one line of context inside. `chart` goes under the figure for
 * tiles that have a real series to show.
 */
export function KpiTile({
  title,
  icon,
  value,
  unit,
  sub,
  chart,
  delay = 0,
  className,
  testId,
}: {
  title: ReactNode
  icon?: ReactNode
  value: ReactNode
  /** Smaller suffix after the figure ("GB", "tok/s"). */
  unit?: ReactNode
  sub?: ReactNode
  chart?: ReactNode
  /** Entrance stagger in ms. */
  delay?: number
  className?: string
  testId?: string
}) {
  return (
    <Frame
      data-testid={testId}
      className={cn('motion-safe:animate-rise-in', className)}
      style={{ animationDelay: `${delay}ms` }}
    >
      <FrameHeader
        title={title}
        actions={
          icon ? (
            <span className="text-muted-foreground [&_svg:not([class*='size-'])]:size-4">
              {icon}
            </span>
          ) : undefined
        }
      />
      <FrameBody className="min-h-[92px] items-start justify-between gap-2.5 p-3">
        <div className="text-2xl leading-none font-medium text-foreground tabular-nums">
          {typeof value === 'string' ? <CountUp value={value} delayMs={delay + 150} /> : value}
          {unit && (
            <small className="ml-1 text-2xl font-medium">{unit}</small>
          )}
        </div>
        {chart && <div className="w-full">{chart}</div>}
        {sub && (
          <div className="min-w-0 truncate text-xs text-muted-foreground">
            {sub}
          </div>
        )}
      </FrameBody>
    </Frame>
  )
}

/** A row of KPI tiles: four across, two on narrow panes. */
export function KpiRow({
  children,
  columns = 4,
}: {
  children: ReactNode
  columns?: 3 | 4
}) {
  return (
    <div
      className={cn(
        'grid gap-4',
        columns === 4
          ? 'grid-cols-2 xl:grid-cols-4'
          : 'grid-cols-2 sm:grid-cols-3 max-sm:[&>*:last-child:nth-child(odd)]:col-span-2'
      )}
    >
      {children}
    </div>
  )
}

const CAP_STYLE: Record<string, { cls: string; icon: ReactNode }> = {
  tools: {
    cls: 'bg-[rgba(217,119,6,.12)] text-[#b45309] dark:text-[#fbbf24]',
    icon: <Wrench />,
  },
  vision: {
    cls: 'bg-[rgba(59,130,246,.12)] text-[#2563eb] dark:text-[#60a5fa]',
    icon: <Eye />,
  },
  reasoning: {
    cls: 'bg-[rgba(139,92,246,.12)] text-[#7c3aed] dark:text-[#a78bfa]',
    icon: <Atom />,
  },
  audio: {
    cls: 'bg-[rgba(8,145,178,.12)] text-[#0e7490] dark:text-[#22d3ee]',
    icon: <Headphones />,
  },
  embeddings: {
    cls: 'bg-[rgba(100,116,139,.14)] text-secondary-foreground',
    icon: <Binary />,
  },
  web_search: {
    cls: 'bg-[rgba(16,185,129,.12)] text-[#047857] dark:text-[#34d399]',
    icon: <Globe />,
  },
}

/** Tinted capability chips (tools, vision, reasoning, audio...). */
export function CapabilityChips({
  capabilities,
  className,
  iconOnly = false,
}: {
  capabilities: string[]
  className?: string
  /** Just the tinted icons, named by their tooltip, for narrow tables. */
  iconOnly?: boolean
}) {
  const shown = capabilities.filter((c) => CAP_STYLE[c])
  if (shown.length === 0) return null
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {shown.map((c) => (
        <span
          key={c}
          title={c === 'web_search' ? 'web search' : c}
          aria-label={iconOnly ? c : undefined}
          className={cn(
            'inline-flex h-5 items-center gap-1 rounded-md text-[11px] font-medium [&_svg]:size-[11px]',
            iconOnly ? 'w-5 justify-center' : 'px-[7px]',
            CAP_STYLE[c].cls
          )}
        >
          {CAP_STYLE[c].icon}
          {!iconOnly && (c === 'web_search' ? 'web' : c)}
        </span>
      ))}
    </span>
  )
}

/**
 * A table in the design's `tbox` style: a rounded 12px box, a pill-shaped
 * header row on the muted surface and dashed row separators with a hover
 * tint. Rows are plain grid rows so each table sets its own columns.
 */
export function TBox({
  head,
  children,
  className,
  columns,
}: {
  head?: ReactNode[]
  children: ReactNode
  className?: string
  /** `grid-template-columns` shared by the header and every row. */
  columns: string
}) {
  return (
    <div
      data-slot="tbox"
      className={cn('flex min-w-0 flex-col rounded-xl', className)}
      style={{ ['--tbox-cols' as string]: columns }}
    >
      {head && (
        <div
          aria-hidden
          className="mb-1 grid grid-cols-[var(--tbox-cols)] items-center gap-3 rounded-lg bg-muted px-2 py-1.5 text-[11px] font-medium text-muted-foreground shadow-[inset_0_0_0_0.8px_var(--border)]"
        >
          {head.map((h, i) => (
            <span key={i} className="min-w-0 truncate">
              {h}
            </span>
          ))}
        </div>
      )}
      {children}
    </div>
  )
}

/** A compact search box with a leading icon (the design's `.input`). */
export function SearchField({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  className?: string
}) {
  return (
    <label
      className={cn(
        'flex h-8 min-w-0 items-center gap-2 rounded-lg border-[0.8px] border-input bg-card px-2.5 transition-[border-color,box-shadow] duration-150 focus-within:border-border-strong focus-within:ring-[3px] focus-within:ring-ring/25 pointer-coarse:h-11',
        className
      )}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full min-w-0 bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none md:text-xs"
      />
    </label>
  )
}

/** Row classes matching `TBox`: dashed separator, hover tint. */
export const TBOX_ROW =
  'grid grid-cols-[var(--tbox-cols)] items-center gap-3 border-b border-dashed border-border px-2 py-2.5 text-[12.5px] transition-colors duration-150 last:border-b-0 hover:bg-hover-row'
