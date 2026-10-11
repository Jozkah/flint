/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { collapsedParts, type CollapsePart } from '@/lib/composerCollapse'

const Ctx = createContext<ReadonlySet<CollapsePart>>(new Set())

/** Tells the controls inside the composer row how much room that row has. */
export function ComposerDensityProvider({
  width,
  children,
}: {
  width: number
  children: ReactNode
}) {
  const parts = useMemo(() => collapsedParts(width), [width])
  return <Ctx.Provider value={parts}>{children}</Ctx.Provider>
}

/** Whether a part of a control should show only its icon right now. */
export function useComposerCollapsed(part: CollapsePart): boolean {
  return useContext(Ctx).has(part)
}
