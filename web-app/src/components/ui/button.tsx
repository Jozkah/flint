/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Flint Graphite Studio buttons: compact, one radius. Primary uses the accent
 * fill with its derived hover, pressed and on-fill colours (lib/accent.ts) and
 * is kept to one per working context. Destructive stays outlined in the error
 * colour so a red-hued accent can never make a primary action look
 * destructive, nor a destructive action look primary. Coarse pointers get
 * 44px targets from the call sites that need them (pointer-coarse:).
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive cursor-pointer",
  {
    variants: {
      variant: {
        default:
          "bg-brand-fill text-brand-foreground border border-brand-fill hover:bg-brand-fill-hover active:bg-brand-fill-pressed",
        destructive:
          "border border-destructive/60 bg-transparent text-destructive hover:bg-destructive-tint active:bg-destructive-tint",
        outline:
          "border border-line-strong bg-card text-foreground hover:border-input hover:bg-card active:bg-sunken",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-accent active:bg-accent",
        ghost:
          "text-ink-2 hover:bg-accent hover:text-foreground active:bg-accent",
        link: "text-brand-text underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3 has-[>svg]:px-2.5",
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 px-2.5 has-[>svg]:px-2",
        lg: "h-9 px-4 has-[>svg]:px-3.5",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-4",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
