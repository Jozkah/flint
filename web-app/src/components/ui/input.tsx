import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // 16px text below md so phone browsers do not zoom into the field.
        "file:text-foreground placeholder:text-muted-foreground border-border hover:border-border-strong h-8 pointer-coarse:h-11 w-full min-w-0 rounded-lg border-[0.8px] bg-card px-2.5 py-1 text-base text-foreground caret-current transition-[border-color,box-shadow] duration-150 outline-hidden file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-[0.8125rem]",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
