import { useState, type ReactNode } from 'react'
import { usePreviewSummary } from '@/hooks/usePreviewSummary'
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
  summaryKey,
  transcript,
  suppressed,
  children,
}: {
  title: string
  /** Epoch milliseconds. */
  updated?: number
  /** The plain line shown until (or instead of) a written summary. */
  summary?: string
  /**
   * Names the conversation in its current state (id, then a NUL, then its
   * last-updated time) so a summary is made once and redone only on change.
   */
  summaryKey?: string
  /** The conversation as text; called when the card opens. */
  transcript?: () => Promise<string> | string
  /** Shut while the row's menu is open, so the card cannot cover it. */
  suppressed: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const written = usePreviewSummary(summaryKey, open && !suppressed, transcript)
  const shown = written.summary ?? summary
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
        className="w-80 max-w-[calc(100vw-2rem)] p-3"
      >
        <p className="line-clamp-2 text-[0.8125rem] font-medium text-foreground">
          {title}
        </p>
        <p className="mt-1 text-[11px] text-subtle-foreground">
          {updated ? new Date(updated).toLocaleString() : ''}
        </p>
        {shown && (
          <p
            data-testid="row-preview-summary"
            className={`mt-2 rounded-lg bg-muted px-2.5 py-2 text-xs leading-relaxed text-secondary-foreground${
              // A written summary is as long as it is; the plain fallback line
              // can be a whole pasted prompt, so it stays cut short.
              written.summary ? '' : ' line-clamp-4'
            }${written.loading && !written.summary ? ' opacity-60' : ''}`}
          >
            {shown}
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
