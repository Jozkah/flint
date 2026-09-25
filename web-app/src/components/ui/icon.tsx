import { memo } from 'react'
import { cn } from '@/lib/utils'
import { ICONS, type IconName } from './icons.data'

export type { IconName }

/**
 * The design's own duotone icons (a light fill under a slate stroke). In the
 * dark theme they are inverted with the hue turned back, the treatment the
 * mockup uses, so greys flip while coloured icons keep their colour.
 */
export const Icon = memo(function Icon({
  name,
  size = 16,
  className,
  label,
}: {
  name: IconName
  size?: number
  className?: string
  /** Accessible name; decorative (hidden) without one. */
  label?: string
}) {
  return (
    <span
      data-slot="icon"
      data-icon={name}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('ic inline-flex shrink-0 [&>svg]:block', className)}
      style={{ width: size, height: size }}
      // Static markup from the generated icon table, never user content.
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  )
})
