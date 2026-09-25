/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Flint buttons: 8px radius, 12px medium text, a short press scale. Primary is
 * the accent gradient (lib/accent.ts) and is kept to one per working context.
 * Outline and surface are the quiet card-coloured buttons that lift on hover.
 * Destructive is a soft error-tinted fill, so a red-hued accent can never
 * make a primary action look destructive, nor the reverse. Coarse pointers
 * get 44px targets from the call sites that need them (pointer-coarse:).
 */
const buttonVariants = cva(
  "relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-xs font-medium transition-[transform,background-color,border-color,box-shadow,color,filter] duration-150 ease-expo active:scale-[.965] disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5 shrink-0 [&_svg]:shrink-0 outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40 aria-invalid:border-destructive cursor-pointer",
  {
    variants: {
      variant: {
        default:
          "overflow-hidden border border-primary bg-grad text-on-grad shadow-[inset_0_1px_0_rgba(255,255,255,.14)] hover:brightness-110 dark:border-white/80",
        destructive:
          "border-[0.8px] border-transparent bg-destructive/12 text-destructive hover:bg-destructive/18",
        outline:
          "border-[0.8px] border-border bg-card text-secondary-foreground hover:border-border-strong hover:bg-hover-btn hover:shadow-lift data-[state=open]:border-border-strong data-[state=open]:bg-hover-btn",
        surface:
          "border-[0.8px] border-input bg-card text-secondary-foreground hover:bg-hover-btn hover:shadow-lift data-[state=open]:bg-hover-btn",
        secondary:
          "border-[0.8px] border-border bg-secondary text-secondary-foreground hover:bg-accent hover:text-foreground",
        ghost:
          "text-secondary-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent",
        link: "text-acc-text underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        default: "h-8 pr-2 pl-2.5 has-[>svg]:px-2",
        xs: "h-6 gap-1 px-2 text-[11px] rounded-md has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 px-2.5 has-[>svg]:px-2",
        lg: "h-9 px-3.5 text-[0.8125rem] has-[>svg]:px-3",
        icon: "size-8",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
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
