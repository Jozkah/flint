/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { useIsNarrowShell } from '@/hooks/use-mobile'
import { useLeftPanel } from '@/hooks/useLeftPanel'

/**
 * Building blocks of the app sidebar: the shell context (open on desktop, the
 * navigation sheet on narrow windows) and the nav rows. Rows are 32px, 8px
 * radius; the current one is a raised card with a hairline, hover is a soft
 * wash. Sub-rows (sessions, rooms, chats) are 28-30px.
 */

type ShellNavContextValue = {
  /** Desktop sidebar shown. */
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
  /** Narrow windows: the navigation sheet. */
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
}

const ShellNavContext = React.createContext<ShellNavContextValue | null>(null)

export function ShellNavProvider({ children }: { children: React.ReactNode }) {
  const open = useLeftPanel((s) => s.open)
  const setLeftPanel = useLeftPanel((s) => s.setLeftPanel)
  const isMobile = useIsNarrowShell()
  const [openMobile, setOpenMobile] = React.useState(false)

  const value = React.useMemo<ShellNavContextValue>(
    () => ({
      open,
      setOpen: setLeftPanel,
      toggle: () =>
        isMobile ? setOpenMobile((v) => !v) : setLeftPanel(!open),
      openMobile,
      setOpenMobile,
      isMobile,
    }),
    [open, setLeftPanel, isMobile, openMobile]
  )
  return (
    <ShellNavContext.Provider value={value}>{children}</ShellNavContext.Provider>
  )
}

/** The shell context when rendered inside the app shell, otherwise null. */
export function useOptionalShellNav() {
  return React.useContext(ShellNavContext)
}

/** Outside the shell (tests, the logs windows) this falls back to a closed,
 * desktop-sized context so rows still render. */
export function useShellNav(): ShellNavContextValue {
  return (
    React.useContext(ShellNavContext) ?? {
      open: true,
      setOpen: () => {},
      toggle: () => {},
      openMobile: false,
      setOpenMobile: () => {},
      isMobile: false,
    }
  )
}

export function NavGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="nav-group"
      className={cn('relative flex w-full min-w-0 flex-col gap-2', className)}
      {...props}
    />
  )
}

export function NavGroupLabel({
  className,
  ...props
}: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="nav-group-label"
      className={cn(
        'm-0 flex h-5 items-center text-xs leading-[1.6] whitespace-nowrap text-muted-foreground uppercase',
        className
      )}
      {...props}
    />
  )
}

export const NavGroupAction = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & { asChild?: boolean }
>(function NavGroupAction({ className, asChild, ...props }, ref) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      ref={ref}
      type="button"
      data-slot="nav-group-action"
      className={cn(
        'grid size-[22px] shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-[background-color,color,transform] duration-150 ease-expo outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.94] data-[state=open]:bg-accent data-[pressed=true]:bg-accent data-[pressed=true]:text-foreground pointer-coarse:size-9 [&_svg:not([class*="size-"])]:size-3.5',
        className
      )}
      {...props}
    />
  )
})

export function NavList({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="nav-list"
      className={cn('m-0 flex w-full min-w-0 list-none flex-col gap-0.5 p-0', className)}
      {...props}
    />
  )
}

export function NavItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="nav-item"
      className={cn('group/nav-item relative', className)}
      {...props}
    />
  )
}

const navButtonVariants = cva(
  'peer/nav-button relative flex w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg border-[0.8px] border-transparent text-left leading-none text-secondary-foreground outline-hidden transition-[background-color,box-shadow,border-color,color,transform] duration-150 ease-expo hover:bg-nav-hover hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.985] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:border-border data-[active=true]:bg-card data-[active=true]:text-foreground data-[active=true]:shadow-[0_4px_7px_rgba(0,0,0,.04)] group-has-data-[slot=nav-action]/nav-item:pr-8 [&>span:last-child]:text-fade [&>svg]:shrink-0 [&>svg:not([class*="size-"])]:size-4 [&>svg]:transition-transform [&>svg]:duration-200 hover:[&>svg:first-child]:scale-110',
  {
    variants: {
      size: {
        default: 'h-8 px-2.5 text-[0.8125rem] pointer-coarse:h-11',
        sm: 'h-[30px] gap-2 px-2 text-[0.8125rem] pointer-coarse:h-11',
        sub: 'h-7 gap-2 px-1.5 text-xs text-muted-foreground data-[active=true]:font-medium pointer-coarse:h-11',
      },
    },
    defaultVariants: { size: 'default' },
  }
)

export const NavButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & {
    asChild?: boolean
    isActive?: boolean
  } & VariantProps<typeof navButtonVariants>
>(function NavButton(
  { asChild = false, isActive = false, size, className, ...props },
  ref
) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      ref={ref}
      data-slot="nav-button"
      data-active={isActive}
      data-size={size ?? 'default'}
      className={cn(navButtonVariants({ size }), className)}
      {...props}
    />
  )
})

export const NavAction = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & { asChild?: boolean; showOnHover?: boolean }
>(function NavAction({ className, asChild, showOnHover = false, ...props }, ref) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      ref={ref}
      data-slot="nav-action"
      className={cn(
        'absolute top-1/2 right-1 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted-foreground transition-[opacity,background-color,color] duration-150 outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 [&>svg]:size-3.5 [&>svg]:shrink-0',
        showOnHover &&
          'opacity-0 group-focus-within/nav-item:opacity-100 group-hover/nav-item:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100',
        className
      )}
      {...props}
    />
  )
})

/** Height-animated disclosure body: rows slide open instead of popping in. */
export function NavCollapse({
  open,
  className,
  children,
  as: Tag = 'div',
}: {
  open: boolean
  className?: string
  children: React.ReactNode
  /** `li` when the collapse sits directly in a NavList (a ul may hold only li). */
  as?: 'div' | 'li'
}) {
  return (
    <Tag
      data-slot="nav-collapse"
      data-state={open ? 'open' : 'closed'}
      inert={!open}
      className={cn(
        'grid transition-[grid-template-rows,opacity,margin] duration-300 ease-expo',
        open ? 'mt-0.5 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        className
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </Tag>
  )
}
