import { useRef } from 'react'
import type { UIMessage } from 'ai'
import { useSecondClock } from '@/lib/sharedClock'

/** How long a streaming reply may sit still before the chat says it is waiting. */
export const QUIET_STREAM_MS = 10_000

const TOOL_DONE = new Set(['output-available', 'output-error', 'output-denied'])

type LoosePart = { type?: string; state?: string; text?: string }

/** A tool call that has not returned: silence then is the tool, not the model. */
function toolPending(parts: readonly LoosePart[]): boolean {
  return parts.some(
    (p) =>
      (p.type?.startsWith('tool-') || p.type === 'dynamic-tool') &&
      !TOOL_DONE.has(p.state ?? '')
  )
}

/** Changes whenever the last message grows: a new part or more text in one. */
function signature(parts: readonly LoosePart[]): string {
  const tail = parts[parts.length - 1]
  return `${parts.length}:${tail?.type ?? ''}:${tail?.text?.length ?? 0}:${tail?.state ?? ''}`
}

/**
 * While a reply streams, the moment its last token landed once nothing has
 * arrived for QUIET_STREAM_MS, else null. A tool that is still running does not
 * count: that wait is the tool's. Ticks from the shared second clock.
 */
export function useStreamQuiet(
  status: string,
  messages: readonly UIMessage[]
): number | null {
  const streaming = status === 'streaming'
  const now = useSecondClock(streaming)
  const last = useRef<{ sig: string; at: number } | null>(null)

  if (!streaming) {
    last.current = null
    return null
  }
  const parts = (messages[messages.length - 1]?.parts ?? []) as LoosePart[]
  const sig = `${messages.length}|${signature(parts)}`
  if (!last.current || last.current.sig !== sig) {
    last.current = { sig, at: Date.now() }
  }
  if (toolPending(parts)) return null
  return now - last.current.at >= QUIET_STREAM_MS ? last.current.at : null
}
