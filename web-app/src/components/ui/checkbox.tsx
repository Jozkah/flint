import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The app's checkbox: a native input (so labels, forms and keyboard keep
 * working) drawn like the rest of the controls. Checked fills with the accent
 * and shows a tick; pass a size class to change the 16px default.
 */
function Checkbox({
  className,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type'>) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        'size-4 shrink-0 cursor-pointer appearance-none rounded-[5px] border border-border bg-[var(--cb)] bg-center bg-no-repeat outline-hidden transition-colors hover:bg-[var(--cb-h)] checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}

export { Checkbox }
