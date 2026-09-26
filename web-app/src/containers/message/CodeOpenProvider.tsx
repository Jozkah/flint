import { useMemo, type ReactNode } from 'react'
import {
  CodeOpenContext,
  CodeOpenToolsContext,
  type CodeOpen,
  type CodePathCheck,
} from '@/lib/codeOpen'

/** Supplies the code-panel opener to the tool widgets below a transcript. */
export const CodeOpenProvider = ({
  open,
  check,
  openDiff,
  children,
}: {
  open: CodeOpen
  /** Why a path cannot be opened, for its tooltip. */
  check?: (path: string) => CodePathCheck
  /** Show a changed file in Changes. */
  openDiff?: (path: string) => void
  children: ReactNode
}) => {
  const tools = useMemo(() => ({ check, openDiff }), [check, openDiff])
  return (
    <CodeOpenContext.Provider value={open}>
      <CodeOpenToolsContext.Provider value={tools}>
        {children}
      </CodeOpenToolsContext.Provider>
    </CodeOpenContext.Provider>
  )
}
