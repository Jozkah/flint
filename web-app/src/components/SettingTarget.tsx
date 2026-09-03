import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  settingTargetClasses,
  useSettingTarget,
} from '@/hooks/useSettingTarget'

/**
 * Marks a whole block as a navigable search target.
 *
 * Use this for a group that is not a single `CardItem` — a whole `Card`, for
 * instance. For a `CardItem`, pass its own `anchor` prop instead: wrapping one
 * in an element breaks the row dividers.
 *
 * The `anchor` is the registry's stable id (`settings-appearance-theme`), never
 * a translated string: a label that changes with the language would break every
 * link into it.
 */
export function SettingTarget({
  anchor,
  children,
  className,
}: {
  anchor: string
  children: ReactNode
  className?: string
}) {
  const ref = useSettingTarget(anchor)

  return (
    <div
      ref={ref}
      id={anchor}
      data-setting-anchor={anchor}
      // -1: reachable when we focus it on arrival, but never inserted into the
      // page's own tab order.
      tabIndex={-1}
      className={cn(settingTargetClasses, className)}
    >
      {children}
    </div>
  )
}
