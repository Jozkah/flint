import type { ReactNode } from 'react'
import { CodeOpenContext, type CodeOpen } from '@/lib/codeOpen'

/** Supplies the code-panel opener to the tool widgets below a transcript. */
export const CodeOpenProvider = ({
  open,
  children,
}: {
  open: CodeOpen
  children: ReactNode
}) => (
  <CodeOpenContext.Provider value={open}>{children}</CodeOpenContext.Provider>
)
