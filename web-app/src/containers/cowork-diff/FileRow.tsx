import { ChevronDown, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** A single expandable row shared by the project and sandbox lists. */
export function FileRow({
  path,
  subtitle,
  additions,
  deletions,
  badge,
  badgeColor,
  indicator,
  note,
  isExpanded,
  onToggle,
  onOpen,
  onOpenExternal,
  after,
  children,
  rowId,
}: {
  /** Open this file in its default app. Absent where it cannot be. */
  onOpenExternal?: () => void
  /** Identifies the row for `focusPath`. */
  rowId?: string
  path: string
  subtitle?: string
  additions: number
  deletions: number
  badge?: string
  badgeColor?: string
  indicator?: string
  /** What is known about who caused this change, when anything is. */
  note?: string
  isExpanded: boolean
  onToggle: () => void
  /** Show this file in the Code panel. Absent where it cannot be opened. */
  onOpen?: () => void
  /** Always shown under the row, expanded or not. */
  after?: React.ReactNode
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const openLabel = t('common:changes.openFile')

  return (
    <div
      className="group/row relative border-b border-dashed border-border"
      data-row-id={rowId}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left text-xs outline-none transition-colors hover:bg-hover-row focus-visible:bg-hover-row pointer-coarse:min-h-11"
      >
        <ChevronDown
          size={12}
          className={cn(
            'shrink-0 text-muted-foreground transition-transform duration-200',
            !isExpanded && '-rotate-90'
          )}
        />
        {badge ? (
          <span
            className={cn(
              'grid size-[18px] shrink-0 place-items-center rounded-[4px] font-mono text-[length:calc(var(--ui-font-base)*0.65625)] font-semibold',
              badgeColor
            )}
            title={badge}
          >
            {badge}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          {onOpen ? (
            // The name opens the file in the Code panel, as a path in a tool
            // card does; the rest of the row still expands the diff.
            <span
              role="link"
              tabIndex={0}
              data-testid="changes-open-path"
              title={t('common:codePanel.openPathHint', { path })}
              className="truncate font-mono text-xs text-fg-2 underline decoration-dotted underline-offset-2 hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
                onOpen()
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.stopPropagation()
                e.preventDefault()
                onOpen()
              }}
            >
              {path}
            </span>
          ) : (
            <span className="truncate font-mono text-xs text-fg-2">{path}</span>
          )}
          {subtitle ? (
            <span className="truncate text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </span>
        {note ? (
          <span className="max-w-[40%] shrink-0 truncate text-[length:calc(var(--ui-font-base)*0.65625)] text-subtle-foreground max-[479px]:hidden">
            {note}
          </span>
        ) : null}
        {indicator ? (
          <span className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] border-[0.8px] border-border bg-card px-1.5 text-[length:calc(var(--ui-font-base)*0.625)] text-muted-foreground">
            {indicator}
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-xs font-medium text-diff-add">
          +{additions}
        </span>
        <span className="shrink-0 font-mono text-xs font-medium text-diff-del">
          −{deletions}
        </span>
      </button>
      {onOpen || onOpenExternal ? (
        <span className="absolute top-1.5 right-2 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              className="rounded-md bg-card px-1.5 py-0.5 text-[length:calc(var(--ui-font-base)*0.65625)] text-secondary-foreground shadow-lift hover:text-foreground"
            >
              {openLabel}
            </button>
          ) : null}
          {onOpenExternal ? (
            <button
              type="button"
              onClick={onOpenExternal}
              data-testid="changes-open-external"
              aria-label={t('common:changes.openExternally')}
              title={t('common:changes.openExternally')}
              className="grid place-items-center rounded-md bg-card px-1.5 py-0.5 text-secondary-foreground shadow-lift hover:text-foreground"
            >
              <ExternalLink size={11} />
            </button>
          ) : null}
        </span>
      ) : null}
      {after}
      {isExpanded ? (
        <div className="border-t border-dashed border-border bg-code-bg motion-safe:animate-tree-in">
          {children}
        </div>
      ) : null}
    </div>
  )
}
