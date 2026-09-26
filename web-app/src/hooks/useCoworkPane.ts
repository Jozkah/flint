import { createContext, useContext, type ReactNode } from 'react'

/**
 * A page shown in a split-view pane that draws the pane's header itself: the
 * pane's title, the page's own controls and the pane's controls in one row,
 * so the title is shown once. Null outside split view.
 */
export type PaneChrome = {
  paneId: string
  isActive: boolean
  /** The pane's own controls: change conversation, close pane. */
  controls: ReactNode
}

/**
 * The active split pane's content card: its hairline in the focus-ring
 * colour, in place of the border colour every other card uses.
 */
export const ACTIVE_PANE_RING = 'shadow-[inset_0_0_0_1px_var(--ring)]'

export const PaneChromeContext =createContext<PaneChrome | null>(null)

export function usePaneChrome(): PaneChrome | null {
  return useContext(PaneChromeContext)
}

/**
 * A Cowork session shown in a split-view pane rather than as the route's own.
 *
 * Absent on the Cowork route itself, where the page shows the current
 * session. Inside a pane the page shows this session instead and keeps its
 * composer draft under the pane's own scope, so two sessions side by side
 * never share a draft.
 */
export type CoworkPane = {
  sessionId: string
  draftScope?: string
}

export const CoworkPaneContext = createContext<CoworkPane | null>(null)

export function useCoworkPane(): CoworkPane | null {
  return useContext(CoworkPaneContext)
}

/**
 * The width of the split-view pane a page is rendered in, or null outside
 * split view. Layouts that switch at a breakpoint read this instead of the
 * window's width, so a page in a narrow pane lays itself out for that pane.
 */
export const PaneWidthContext = createContext<number | null>(null)

export function usePaneWidth(): number | null {
  return useContext(PaneWidthContext)
}
