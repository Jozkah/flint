import { cn } from '@/lib/utils'
import { ReactNode } from 'react'
import {
  settingTargetClasses,
  useSettingTarget,
} from '@/hooks/useSettingTarget'

type CardProps = {
  title?: string
  children?: ReactNode
  header?: ReactNode
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
   * Applied to the row's own element rather than a wrapper: the row is styled
   * with `first:mt-0` and `last:border-none`, which are relative to its parent,
   * so wrapping it would make every row both first and last and strip the
   * dividers from the whole card.
   */
  anchor?: string
}

/**
 * One setting: a label and explanation on the left, its control on the right.
 * On narrow screens the control drops below the text instead of squeezing it.
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
          'flex flex-col gap-3 border-b border-border py-3.5 first:pt-0 last:border-none last:pb-0 sm:flex-row sm:justify-between sm:gap-8',
          descriptionOutside && 'border-0',
          align === 'start' && 'sm:items-start',
          align === 'center' && 'sm:items-center',
          align === 'end' && 'sm:items-end',
          column && 'sm:flex-col gap-y-3 sm:items-start',
          anchor && settingTargetClasses,
          className
        )}
      >
        <div className="min-w-0 space-y-1">
          <h1 className="font-medium text-foreground">{title}</h1>
          {description && (
            <span className="block text-muted-foreground leading-normal">
              {description}
            </span>
          )}
        </div>
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
        <span className="text-muted-foreground leading-normal">
          {descriptionOutside}
        </span>
      )}
    </>
  )
}

/** A group of settings on a paper surface with a hairline border. */
export function Card({ title, children, header }: CardProps) {
  return (
    <section className="w-full rounded-lg border border-border bg-card p-4 text-muted-foreground md:p-5">
      {title && (
        <h1 className="mb-4 font-display text-xl font-normal text-foreground">
          {title}
        </h1>
      )}
      {header && header}
      {children}
    </section>
  )
}
