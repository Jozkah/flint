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
