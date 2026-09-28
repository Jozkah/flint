import { useState, type ReactNode } from 'react'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'

/**
 * A peek at a nav row without opening it: its title, when it was last active
 * and a line of what it is about. The same card ThreadList.tsx shows for a
 * chat, for rows (cowork sessions, rooms) that are not chats.
 */
export function RowPreview({
  title,
  updated,
  summary,
  suppressed,
  children,
}: {
  title: string
  /** Epoch milliseconds. */
  updated?: number
  summary?: string
  /** Shut while the row's menu is open, so the card cannot cover it. */
  suppressed: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <HoverCard
      openDelay={650}
      closeDelay={80}
      open={open && !suppressed}
      onOpenChange={setOpen}
    >
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={10}
        className="w-72 p-3"
      >
        <p className="line-clamp-2 text-[0.8125rem] font-medium text-foreground">
          {title}
        </p>
        <p className="mt-1 text-[11px] text-subtle-foreground">
          {updated ? new Date(updated).toLocaleString() : ''}
        </p>
        {summary && (
          <p className="mt-2 line-clamp-4 rounded-lg bg-muted px-2.5 py-2 text-xs leading-relaxed text-secondary-foreground">
            {summary}
          </p>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}

/** The text of the last thing the user asked, from AI SDK UI messages. */
export function lastUserText(
  messages:
    | { role: string; parts?: { type: string; text?: string }[] }[]
    | undefined
): string | undefined {
  if (!messages) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const text = m.parts?.find((p) => p.type === 'text')?.text
    if (text) return text
  }
  return undefined
}
