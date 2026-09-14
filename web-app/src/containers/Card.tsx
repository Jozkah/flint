import { cn } from '@/lib/utils'
import { ReactNode } from 'react'
import {
  settingTargetClasses,
  useSettingTarget,
} from '@/hooks/useSettingTarget'

type CardProps = {
  title?: string | ReactNode
  /** One line under the group title, for groups that need a sentence. */
  description?: string | ReactNode
  /** Rendered at the end of the title row: a count, a link, a small action. */
  aside?: ReactNode
  children?: ReactNode
  /** Free-form content above the rows, kept for callers that build their own header. */
  header?: ReactNode
  className?: string
  /** Classes for the body that holds the rows. */
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
   * divider with `last:border-none`, which is relative to its parent, so
   * wrapping it would make every row the last one and strip the dividers from
   * the whole group.
   */
  anchor?: string
}

/**
 * One setting inside a group: the label and a readable explanation on the
 * left, its control on the right. On narrow screens the control wraps below
 * the text instead of squeezing it.
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
        tabIndex={anchor ? -1 : undefined}
        className={cn(
          'flex flex-col gap-2.5 border-b border-border py-3 last:border-none sm:flex-row sm:justify-between sm:gap-6',
          descriptionOutside && 'border-0',
          align === 'start' && 'sm:items-start',
          align === 'center' && 'sm:items-center',
          align === 'end' && 'sm:items-end',
          column && 'sm:flex-col gap-y-3 sm:items-start',
          anchor && settingTargetClasses,
          className
        )}
      >
        {(title || description) && (
          <div className="min-w-0 space-y-0.5">
            {title && (
              <div className="text-sm font-medium leading-5 text-foreground">
                {title}
              </div>
            )}
            {description && (
              <div className="text-[13px] leading-normal text-muted-foreground">
                {description}
              </div>
            )}
          </div>
        )}
        {actions && (
          <div
            className={cn(
              'min-w-0 shrink-0',
              classNameWrapperAction,
              column && 'w-full'
            )}
          >
            {actions}
          </div>
        )}
      </div>
      {descriptionOutside && (
        <div className="pb-3 text-[13px] leading-normal text-muted-foreground">
          {descriptionOutside}
        </div>
      )}
    </>
  )
}

/**
 * A settings group (JAN Graphite Studio): a bordered `rounded-lg` object with
 * a compact title row and integrated rows separated by hairlines. No shadow,
 * no oversized heading.
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
      className={cn(
        'w-full min-w-0 rounded-lg border border-border bg-card text-ink-2',
        anchor && settingTargetClasses,
        anchor && 'rounded-lg',
        className
      )}
    >
      {(title || aside) && (
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-2">
          {title && (
            <h2 className="min-w-0 text-[13px] font-semibold text-foreground">
              {title}
            </h2>
          )}
          {aside && (
            <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              {aside}
            </div>
          )}
          {description && (
            <p className="basis-full text-[13px] leading-normal text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      )}
      <div className={cn('px-4 py-1', bodyClassName)}>
        {header && header}
        {children}
      </div>
    </section>
  )
}
