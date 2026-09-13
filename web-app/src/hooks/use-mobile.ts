import * as React from "react"

const MOBILE_BREAKPOINT = 768
/**
 * Below this width the shell's rail and contextual sidebar move into the
 * navigation sheet: a phone in landscape or a tablet in portrait has too
 * little room for 80px + 256px of persistent navigation. Matches Tailwind `lg`.
 */
export const NARROW_SHELL_BREAKPOINT = 1024

function useBelow(breakpoint: number) {
  const [below, setBelow] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const onChange = () => {
      setBelow(window.innerWidth < breakpoint)
    }
    mql.addEventListener("change", onChange)
    setBelow(window.innerWidth < breakpoint)
    return () => mql.removeEventListener("change", onChange)
  }, [breakpoint])

  return !!below
}

export function useIsMobile() {
  return useBelow(MOBILE_BREAKPOINT)
}

/** True while the shell uses the navigation sheet instead of rail + sidebar. */
export function useIsNarrowShell() {
  return useBelow(NARROW_SHELL_BREAKPOINT)
}
