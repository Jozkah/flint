import * as React from 'react'
import { useReducedMotion } from 'motion/react'

import { cn } from '@/lib/utils'

const MAX_TILT = 14

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n))

/**
 * Centred empty state: an icon tile, a one-line title, a short hint and an
 * optional action. Used wherever a list or panel has nothing to show yet.
 * The tile floats, ripples and tilts toward the pointer unless motion is reduced.
 */
function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  onPointerMove,
  onPointerLeave,
  ...props
}: Omit<React.ComponentProps<'div'>, 'title'> & {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  const reduce = useReducedMotion()
  const tile = React.useRef<HTMLSpanElement>(null)

  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(e)
    const el = tile.current
    if (!el || reduce) return
    const r = el.getBoundingClientRect()
    const dx = (e.clientX - (r.left + r.width / 2)) / 120
    const dy = (e.clientY - (r.top + r.height / 2)) / 120
    el.style.transform = `perspective(260px) rotateX(${clamp(-dy * MAX_TILT, -MAX_TILT, MAX_TILT)}deg) rotateY(${clamp(dx * MAX_TILT, -MAX_TILT, MAX_TILT)}deg)`
  }
  const handleLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    onPointerLeave?.(e)
    if (tile.current) tile.current.style.transform = ''
  }

  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex w-full flex-1 flex-col items-center justify-center gap-1.5 px-4 py-8 text-center motion-safe:animate-rise-in',
        className
      )}
      onPointerMove={handleMove}
      onPointerLeave={handleLeave}
      {...props}
    >
      {icon && (
        <span
          ref={tile}
          data-slot="empty-state-tile"
          className="es-tile mb-2 grid size-10 place-items-center rounded-xl bg-card text-muted-foreground shadow-lift [&_svg:not([class*='size-'])]:size-4.5"
        >
          {icon}
          {!reduce && (
            <>
              <span className="es-orb" aria-hidden="true" />
              <span className="es-orb es-orb-b" aria-hidden="true" />
            </>
          )}
        </span>
      )}
      <p className="text-[0.8125rem] font-medium text-foreground motion-safe:animate-rise-in">
        {title}
      </p>
      {description && (
        <p
          className="max-w-xs text-xs text-muted-foreground motion-safe:animate-rise-in"
          style={{ animationDelay: '80ms' }}
        >
          {description}
        </p>
      )}
      {action && (
        <div
          className="mt-3 motion-safe:animate-rise-in"
          style={{ animationDelay: '160ms' }}
        >
          {action}
        </div>
      )}
    </div>
  )
}

export { EmptyState }
