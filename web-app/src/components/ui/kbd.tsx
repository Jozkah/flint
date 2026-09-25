import { cn } from "@/lib/utils"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "bg-card text-muted-foreground pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-[5px] px-1 font-sans text-[11px] font-medium select-none shadow-[inset_0_0_0_0.8px_var(--border),0_1px_0_var(--border)]",
        "[&_svg:not([class*='size-'])]:size-3",
        "in-data-[slot=tooltip-content]:bg-on-grad/15 in-data-[slot=tooltip-content]:text-on-grad in-data-[slot=tooltip-content]:shadow-none",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
