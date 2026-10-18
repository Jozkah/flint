import * as React from 'react'
import * as ProgressPrimitive from '@radix-ui/react-progress'

import { cn } from '@/lib/utils'

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      // Radix derives aria-valuenow and data-state from this; it rejects a
      // value outside 0..max, so clamp it for the root only.
      value={value == null ? value : Math.min(100, Math.max(0, value))}
      className={cn(
        'bg-track relative h-1.5 w-full overflow-hidden rounded-full',
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="bg-grad h-full w-full flex-1 rounded-full transition-transform duration-700 ease-expo"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
