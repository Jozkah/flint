import { Fragment, useMemo, type ReactNode } from 'react'
import { GitFork } from 'lucide-react'
import { NavButton, NavCollapse, NavItem } from '@/components/shell/nav-kit'
import { FadeText } from '@/components/ui/fade-text'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  buildNestTree,
  countNested,
  isStickyStatus,
  splitNested,
  type NestCounts,
  type NestRoot,
  type NestStatus,
} from '@/lib/nesting'
import { cn } from '@/lib/utils'
import { useNestExpanded } from '@/stores/nest-expanded-store'

export type NestedRowsProps = {
  /** Which list this is; part of the remembered expand key. */
  scope: 'chats' | 'cowork'
  /** The list's rows in its own order. */
  ids: readonly string[]
  /** The recorded parent of a row, if any. */
  parentOf: (id: string) => string | null | undefined
  /** Recency, for ordering nested rows (larger is newer). */
  updatedOf: (id: string) => number
  statusOf: (id: string) => NestStatus
  /** The open row: never folded away. */
  selectedId?: string
  /** One row, as a list item (`li`) the list would render anyway. */
  renderRow: (id: string) => ReactNode
}

/**
 * A list whose rows can sit under a parent row: the parent, up to three
 * nested rows on a rail, and one summary row ("17 more nested · 12 new ·
 * 5 working") that unfolds the rest. Rows without nested ones render exactly
 * as they did. Each row is still the list's own row: menus, rename, delete
 * and dragging work as before.
 */
export function NestedRows({
  scope,
  ids,
  parentOf,
  updatedOf,
  statusOf,
  selectedId,
  renderRow,
}: NestedRowsProps) {
  const tree = useMemo(
    () =>
      buildNestTree(
        ids.map((id) => ({ id, parentId: parentOf(id), updated: updatedOf(id) }))
      ),
    [ids, parentOf, updatedOf]
  )
  return (
    <>
      {tree.map((root) =>
        root.nested.length === 0 ? (
          <Fragment key={root.id}>{renderRow(root.id)}</Fragment>
        ) : (
          <NestBlock
            key={root.id}
            scope={scope}
            root={root}
            statusOf={statusOf}
            selectedId={selectedId}
            renderRow={renderRow}
          />
        )
      )}
    </>
  )
}

/** The rail beside a nested row; the last one ends in an elbow. */
function NestChild({ last, children }: { last: boolean; children: ReactNode }) {
  return (
    <li className="relative list-none pl-[18px]" data-testid="nest-child">
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute -top-0.5 left-[13px] w-px bg-border',
          last ? 'h-[calc(50%+2px)]' : '-bottom-0.5'
        )}
      />
      {last && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-[13px] h-px w-[5px] bg-border"
        />
      )}
      <ul className="m-0 list-none p-0">{children}</ul>
    </li>
  )
}

/** "17 more nested, 12 new, 5 working, 1 waiting", for the summary row. */
function summaryParts(counts: NestCounts, t: (k: string, o?: Record<string, unknown>) => string) {
  return {
    more: t('common:nesting.more', { count: counts.total }),
    fresh: counts.fresh ? t('common:nesting.new', { count: counts.fresh }) : null,
    working: counts.working
      ? t('common:nesting.working', { count: counts.working })
      : null,
    waiting: counts.waiting
      ? t('common:nesting.waiting', { count: counts.waiting })
      : null,
  }
}

function NestBlock({
  scope,
  root,
  statusOf,
  selectedId,
  renderRow,
}: {
  scope: NestedRowsProps['scope']
  root: NestRoot
  statusOf: NestedRowsProps['statusOf']
  selectedId?: string
  renderRow: NestedRowsProps['renderRow']
}) {
  const { t } = useTranslation()
  const key = `${scope}:${root.id}`
  const expanded = useNestExpanded((s) => !!s.expanded[key])
  const toggle = useNestExpanded((s) => s.toggle)
  // Folded layout always: the rows past it slide in and out of one collapse.
  const { shown, hidden } = splitNested(root.nested, {
    expanded: false,
    sticky: (id) => isStickyStatus(statusOf(id), id === selectedId),
  })
  const counts = countNested(hidden, statusOf)
  const parts = summaryParts(counts, t)
  const hasSummary = hidden.length > 0
  const label = expanded
    ? t('common:nesting.fewer')
    : [parts.more, parts.fresh, parts.working, parts.waiting]
        .filter(Boolean)
        .join(', ')
  const nestedLabel = t('common:nesting.count', { count: root.nested.length })
  return (
    <>
      <li
        className="group/nest relative list-none"
        data-testid="nest-parent"
        data-nest-id={root.id}
      >
        {/* Room for the count at the right; the row's own menu covers it on hover. */}
        <ul className="m-0 list-none p-0 [&_[data-slot=nav-button]]:!pr-9">
          {renderRow(root.id)}
        </ul>
        <span
          title={nestedLabel}
          data-testid="nest-count"
          className="pointer-events-none absolute top-1/2 right-2.5 flex -translate-y-1/2 items-center gap-0.5 text-[length:calc(var(--ui-font-base)*0.6875)] text-subtle-foreground tabular-nums transition-opacity duration-150 group-focus-within/nest:opacity-0 group-hover/nest:opacity-0 pointer-coarse:hidden"
        >
          <GitFork aria-hidden className="size-3" />
          <span aria-hidden>{root.nested.length}</span>
          <span className="sr-only">{nestedLabel}</span>
        </span>
      </li>
      {shown.map((id, i) => (
        <NestChild key={id} last={!hasSummary && i === shown.length - 1}>
          {renderRow(id)}
        </NestChild>
      ))}
      {hasSummary && (
        <>
          <NavCollapse as="li" open={expanded} className="list-none">
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {hidden.map((id) => (
                <NestChild key={id} last={false}>
                  {renderRow(id)}
                </NestChild>
              ))}
            </ul>
          </NavCollapse>
          <NestChild last>
            <NavItem>
              <NavButton
                size="sub"
                aria-expanded={expanded}
                aria-label={label}
                title={label}
                onClick={() => toggle(key)}
                data-testid="nest-summary"
                className="h-6 text-[length:calc(var(--ui-font-base)*0.75)]"
              >
                <FadeText>
                  {expanded ? (
                    t('common:nesting.fewer')
                  ) : (
                    <>
                      {parts.more}
                      {parts.fresh && (
                        <>
                          <Sep />
                          <span className="inline-flex items-center gap-1 text-info">
                            <span aria-hidden className="size-1.5 rounded-full bg-current" />
                            {parts.fresh}
                          </span>
                        </>
                      )}
                      {parts.working && (
                        <>
                          <Sep />
                          {parts.working}
                        </>
                      )}
                      {parts.waiting && (
                        <>
                          <Sep />
                          <span className="inline-flex items-center gap-1 text-warning">
                            <span aria-hidden className="size-1.5 rounded-full bg-current" />
                            {parts.waiting}
                          </span>
                        </>
                      )}
                    </>
                  )}
                </FadeText>
              </NavButton>
            </NavItem>
          </NestChild>
        </>
      )}
    </>
  )
}

function Sep() {
  return (
    <span aria-hidden className="px-1 text-subtle-foreground">
      ·
    </span>
  )
}
