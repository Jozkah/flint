import { cn } from '@/lib/utils'
import { ReactNode } from 'react'
import {
  settingTargetClasses,
  useSettingTarget,
} from '@/hooks/useSettingTarget'

type CardProps = {
  title?: string | ReactNode
  /** One sentence opening the group's panel, for groups that need it. */
  description?: string | ReactNode
  /** Rendered at the end of the title row: a count, a link, a small action. */
  aside?: ReactNode
  children?: ReactNode
  /** Free-form content above the rows, kept for callers that build their own header. */
  header?: ReactNode
  className?: string
  /** Classes for the panel that holds the rows. */
  bodyClassName?: string
  'data-testid'?: string
  /** Stable settings-search id for the whole group. */
  anchor?: string
}

type CardItemProps = {
  title?: string | ReactNode
  description?: string | ReactNode
  descriptionOutside?: string | ReactNode
  align?: 'start' | 'center' | 'end'
  actions?: ReactNode
  column?: boolean
  className?: string
  classNameWrapperAction?: string
  /**
   * Stable settings-search id for this row, e.g. `settings-appearance-theme`.
   *
   * Applied to the row's own element rather than a wrapper: the row draws its
   * divider with `last:border-b-0`, which is relative to its parent, so
   * wrapping it would make every row the last one and strip the dividers from
   * the whole group.
   */
  anchor?: string
}

/**
 * One setting inside a group (the design's `.srow`): the label and a readable
 * explanation on the left, its control on the right, rows parted by a dashed
 * hairline. On narrow screens the control wraps below the text instead of
 * squeezing it.
 */
export function CardItem({
  title,
  description,
  descriptionOutside,
  className,
  classNameWrapperAction,
  align = 'center',
  column,
  actions,
  anchor,
}: CardItemProps) {
  const targetRef = useSettingTarget(anchor ?? '')
  return (
    <>
      <div
        ref={anchor ? targetRef : undefined}
        id={anchor}
        data-setting-anchor={anchor}
        data-slot="setting-row"
        tabIndex={anchor ? -1 : undefined}
        className={cn(
          'flex flex-col gap-2.5 border-b border-dashed border-border px-0.5 py-[11px] last:border-b-0 sm:flex-row sm:justify-between sm:gap-4',
          descriptionOutside && 'border-b-0',
          align === 'start' && 'sm:items-start',
          align === 'center' && 'sm:items-center',
          align === 'end' && 'sm:items-end',
          column && 'gap-y-3 sm:flex-col sm:items-stretch',
          anchor && settingTargetClasses,
          className
        )}
      >
        {(title || description) && (
          <div className="flex min-w-0 flex-[1_1_auto] flex-col gap-1.5 sm:min-w-[110px]">
            {title && (
              <div className="text-[13px] leading-tight font-medium text-foreground">
                {title}
              </div>
            )}
            {description && (
              <div className="text-xs leading-[1.4] text-muted-foreground">
                {description}
              </div>
            )}
          </div>
        )}
        {actions && (
          <div
            data-slot="setting-control"
            className={cn(
              'flex min-w-0 shrink-0 flex-wrap items-center gap-2 text-[13px] text-fg-2 sm:max-w-[58%] sm:justify-end',
              classNameWrapperAction,
              column && 'w-full sm:max-w-none sm:justify-start'
            )}
          >
            {actions}
          </div>
        )}
      </div>
      {descriptionOutside && (
        <div className="border-b border-dashed border-border pb-3 text-xs leading-[1.4] text-muted-foreground last:border-b-0">
          {descriptionOutside}
        </div>
      )}
    </>
  )
}

/**
 * A settings group, drawn as the design's Frame: a muted shell carrying the
 * group title, and a raised inner panel holding the rows. The optional
 * description opens the panel as one muted sentence.
 */
export function Card({
  title,
  description,
  aside,
  children,
  header,
  className,
  bodyClassName,
  'data-testid': testId,
  anchor,
}: CardProps) {
  const targetRef = useSettingTarget(anchor ?? '')
  return (
    <section
      ref={anchor ? targetRef : undefined}
      id={anchor}
      data-setting-anchor={anchor}
      tabIndex={anchor ? -1 : undefined}
      data-testid={testId}
      data-slot="frame"
      className={cn(
        'relative flex w-full min-w-0 flex-col overflow-clip rounded-xl bg-muted p-1 text-fg-2 shadow-[inset_0_0_0_0.8px_var(--border)]',
        anchor && settingTargetClasses,
        anchor && 'rounded-xl',
        className
      )}
    >
      {(title || aside) && (
        <header
          data-slot="frame-header"
          className="flex min-h-9 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 p-2"
        >
          {title && (
            <h2 className="min-w-0 text-sm leading-none font-medium text-secondary-foreground">
              {title}
            </h2>
          )}
          {aside && (
            <div className="ml-auto flex shrink-0 items-center gap-2 text-[13px] text-muted-foreground">
              {aside}
            </div>
          )}
        </header>
      )}
      <div
        data-slot="frame-body"
        className={cn(
          'relative flex min-w-0 flex-col rounded-xl border-[0.8px] border-input bg-card px-3.5 py-[3px]',
          bodyClassName
        )}
      >
        {description && (
          <p className="mt-2.5 mb-0.5 text-[12.5px] leading-normal text-muted-foreground">
            {description}
          </p>
        )}
        {header && header}
        {children}
      </div>
    </section>
  )
}
