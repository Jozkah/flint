/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * JAN Atelier buttons. Primary uses the accent fill with its derived hover,
 * pressed and on-fill colours (lib/accent.ts). Destructive stays outlined in
 * the error colour so a red-hued accent can never make a primary action look
 * destructive, nor a destructive action look primary.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive cursor-pointer",
  {
    variants: {
      variant: {
        default:
          "bg-brand-fill text-brand-foreground font-semibold border border-brand hover:bg-brand-fill-hover active:bg-brand-fill-pressed",
        destructive:
          "border border-destructive/70 bg-transparent text-destructive hover:bg-destructive-tint active:bg-destructive-tint",
        outline:
          "border border-line-strong bg-card text-foreground hover:bg-sunken active:bg-accent",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-accent active:bg-accent",
        ghost:
          "text-foreground hover:bg-sunken active:bg-accent",
        link: "text-brand-text underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 px-5 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-4",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
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
