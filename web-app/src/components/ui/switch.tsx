import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { cn } from '@/lib/utils'
import { IconLoader2 } from '@tabler/icons-react'

type SwitchProps = React.ComponentProps<typeof SwitchPrimitive.Root> & {
  loading?: boolean
}
function Switch({ loading, className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        // Checked uses the accent indicator (3:1 against the page in both
        // themes); the fill colour itself may be too light to see as a track.
        // On touch screens an invisible margin brings the target to 44px.
        'relative peer cursor-pointer data-[state=checked]:bg-brand data-[state=unchecked]:bg-input inline-flex h-[18px] w-8.5 shrink-0 items-center rounded-full border border-transparent outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 transition-colors pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-[""]',
        loading && 'w-4.5 pointer-events-none',
        className
      )}
      {...props}
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10 size-3.5 top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2">
          <IconLoader2 className="animate-spin text-muted-foreground" />
        </div>
      )}
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'bg-card pointer-events-none block size-4 rounded-full ring-0 shadow-xs transition-transform data-[state=checked]:translate-x-[calc(100%)] data-[state=unchecked]:translate-x-0'
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
