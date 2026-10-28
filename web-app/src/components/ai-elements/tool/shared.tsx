/* eslint-disable react-refresh/only-export-components */
import { cn } from '@/lib/utils'
import type { ToolUIPart } from 'ai'
import { createContext, useContext } from 'react'

/** One section of an open tool card, under a dashed rule. */
export const TOOL_SECTION =
  'min-w-0 border-t border-dashed border-border px-2.5 py-2'

/** The mockup's small "Table | Raw" switch: two options on a muted track. */
export const MINI_TRACK = 'inline-flex rounded-md bg-accent p-0.5'
export const miniOption = (on: boolean) =>
  cn(
    'rounded px-[7px] py-0.5 text-[length:calc(var(--ui-font-base)*0.6875)] leading-4 transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:min-h-11',
    on
      ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]'
      : 'text-muted-foreground hover:text-foreground'
  )

/** Payloads shorter than this fit the collapsed box, so no expand control. */
export const OUTPUT_EXPAND_THRESHOLD = 600

type ToolContextValue = {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  state: ToolUIPart['state']
  toolCallId?: string
  messageId?: string
}

export const ToolContext = createContext<ToolContextValue | null>(null)

export const useTool = () => {
  const context = useContext(ToolContext)
  if (!context) {
    throw new Error('Tool components must be used within Tool')
  }
  return context
}
