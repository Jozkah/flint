/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, type ReactNode } from 'react'

/**
 * Pages put their context controls (title, actions) in the shell's top header
 * through `HeaderPage`, which portals into the element registered here.
 * Outside the shell (tests, the logs windows) there is no slot and
 * `HeaderPage` renders in place instead.
 */
const HeaderSlotContext = createContext<{
  slot: HTMLElement | null
  setSlot: (el: HTMLElement | null) => void
} | null>(null)

export function HeaderSlotProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return (
    <HeaderSlotContext.Provider value={{ slot, setSlot }}>
      {children}
    </HeaderSlotContext.Provider>
  )
}

export function useHeaderSlot() {
  return useContext(HeaderSlotContext)
}

/**
 * Inside a split-view pane a page's context controls belong to the pane, not
 * the shell's header: with no slot, `HeaderPage` renders them in place.
 */
export function NoHeaderSlot({ children }: { children: ReactNode }) {
  return (
    <HeaderSlotContext.Provider value={null}>
      {children}
    </HeaderSlotContext.Provider>
  )
}

/**
 * `NoHeaderSlot` while `inPane`, the shell's slot otherwise. The provider is
 * always there, so turning split view on or off never remounts the page.
 */
export function PaneHeaderSlot({
  inPane,
  children,
}: {
  inPane: boolean
  children: ReactNode
}) {
  const parent = useContext(HeaderSlotContext)
  return (
    <HeaderSlotContext.Provider value={inPane ? null : parent}>
      {children}
    </HeaderSlotContext.Provider>
  )
}
