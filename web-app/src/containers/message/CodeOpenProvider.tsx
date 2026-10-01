import { useMemo, type ReactNode } from 'react'
import {
  CodeOpenContext,
  CodeOpenToolsContext,
  PathRootsContext,
  type CodeOpen,
  type CodePathCheck,
} from '@/lib/codeOpen'

const NO_ROOTS: readonly string[] = []

/** Supplies the code-panel opener to the tool widgets below a transcript. */
export const CodeOpenProvider = ({
  open,
  check,
  openDiff,
  displayPath,
  roots,
  children,
}: {
  open: CodeOpen
  /** Why a path cannot be opened, for its tooltip. */
  check?: (path: string) => CodePathCheck
  /** Show a changed file in Changes. */
  openDiff?: (path: string) => void
  /** The short form a path is shown as. */
  displayPath?: (path: string) => string
  /** The folders absolute paths in a reply may open from. */
  roots?: readonly string[]
  children: ReactNode
}) => {
  const tools = useMemo(
    () => ({ check, openDiff, displayPath }),
    [check, openDiff, displayPath]
  )
  return (
    <CodeOpenContext.Provider value={open}>
      <CodeOpenToolsContext.Provider value={tools}>
        <PathRootsContext.Provider value={roots ?? NO_ROOTS}>
          {children}
        </PathRootsContext.Provider>
      </CodeOpenToolsContext.Provider>
    </CodeOpenContext.Provider>
  )
}
