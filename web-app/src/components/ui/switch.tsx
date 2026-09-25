import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { cn } from '@/lib/utils'
import { Loader2 } from 'lucide-react'

type SwitchProps = React.ComponentProps<typeof SwitchPrimitive.Root> & {
  loading?: boolean
}
function Switch({ loading, className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        // Checked fills with the accent gradient; the knob stretches while
        // pressed. On touch screens an invisible margin brings the target to
        // 44px.
        'group/switch relative peer cursor-pointer data-[state=checked]:bg-grad data-[state=unchecked]:bg-[var(--cb)] data-[state=unchecked]:hover:bg-[var(--cb-h)] inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full p-0.5 outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 transition-colors pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-[""]',
        loading && 'w-4.5 pointer-events-none',
        className
      )}
      {...props}
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10 size-3.5 top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2">
          <Loader2 className="animate-spin text-muted-foreground" />
        </div>
      )}
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'bg-knob pointer-events-none block size-3.5 rounded-full ring-0 shadow-[0_2.2px_3px_rgba(27,28,29,.12)] transition-[transform,width] duration-300 ease-expo data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0 group-active/switch:w-[17px] group-active/switch:data-[state=checked]:translate-x-[9px] dark:data-[state=checked]:bg-on-grad'
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
