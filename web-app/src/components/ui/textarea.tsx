import * as React from "react"

import { cn } from "@/lib/utils"
import { useGeneralSetting } from "@/hooks/useGeneralSetting"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  const spellCheckChatInput = useGeneralSetting((s) => s.spellCheckChatInput)
  return (
    <textarea
      data-slot="textarea"
      spellCheck={spellCheckChatInput}
      className={cn(
        "border-border placeholder:text-muted-foreground hover:border-border-strong focus-visible:border-ring focus-visible:ring-ring/20 aria-invalid:border-destructive aria-invalid:ring-destructive/20 flex field-sizing-content min-h-16 w-full rounded-lg border-[0.8px] bg-card px-2.5 py-2 text-base leading-normal text-foreground transition-[border-color,box-shadow] duration-150 outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-[0.8125rem] wrap-anywhere",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
