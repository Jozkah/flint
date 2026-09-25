/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { useSeen } from '@/stores/seen-store'

/**
 * The mark before a chat or session in the sidebar. Nothing for an inactive
 * chat, a blue dot for one that finished within the last hour and has not been
 * looked at since (opening it clears the dot), a blinking blue dot while
 * it is working, and yellow while it waits for the user's answer. Pull-request
 * states (open, merged, closed, draft) use the GitHub glyphs in their colours.
 */
export type ThreadStatus =
  | 'none'
  | 'recent'
  | 'active'
  | 'wait'
  | 'pr'
  | 'draft'
  | 'merged'
  | 'closed'

const RECENT_MS = 60 * 60 * 1000

/** `updated` is stored in seconds by older threads and milliseconds by newer
 * ones; anything below 1e12 is taken as seconds. */
export function updatedMs(updated: number | undefined): number {
  if (!updated) return 0
  return updated < 1e12 ? updated * 1000 : updated
}

export function statusFor(
  thread: Pick<Thread, 'updated'>,
  working: boolean,
  now: number,
  waiting = false,
  /** When the user last looked at it (epoch ms); 0 when never. */
  seenMs = 0
): ThreadStatus {
  if (waiting) return 'wait'
  if (working) return 'active'
  const updated = updatedMs(thread.updated)
  if (now - updated < RECENT_MS && updated > seenMs) return 'recent'
  return 'none'
}

/**
 * Re-evaluated every minute so "recent" fades out without a reload. With an
 * `id`, the dot also clears once the item has been seen: while it is the one
 * open (`selected`), every change it makes is marked seen as it lands.
 */
export function useThreadStatus(
  thread: Pick<Thread, 'updated'>,
  working: boolean,
  waiting = false,
  seenAs?: { id: string; selected?: boolean }
): ThreadStatus {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  const seenId = seenAs?.id
  const selected = Boolean(seenAs?.selected)
  const seenMs = useSeen((s) => (seenId ? (s.seen[seenId] ?? 0) : 0))
  const updated = updatedMs(thread.updated)
  // Re-run when the run ends too, so a reply finishing while the item is
  // open is marked seen rather than lighting the dot.
  useEffect(() => {
    if (seenId && selected)
      useSeen.getState().markSeen(seenId, Math.max(Date.now(), updated))
  }, [seenId, selected, updated, working])
  if (selected && !working && !waiting) return 'none'
  return statusFor(thread, working, now, waiting, seenId ? seenMs : 0)
}

const OCTICON: Partial<Record<ThreadStatus, string>> = {
  pr: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.12v5.26a2.25 2.25 0 1 1-1.5 0V5.37A2.25 2.25 0 0 1 1.5 3.25Zm5.68-.53L8.97.93A.25.25 0 0 1 9.4 1.1V2.5h1.35a2.75 2.75 0 0 1 2.75 2.75v5.38a2.25 2.25 0 1 1-1.5 0V5.25c0-.69-.56-1.25-1.25-1.25H9.4v1.4a.25.25 0 0 1-.43.17L7.18 3.78a.75.75 0 0 1 0-1.06ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  merged:
    'M5.45 5.15A2.25 2.25 0 1 0 4.5 5.37v5.26a2.25 2.25 0 1 0 1.5 0V8.8a4.24 4.24 0 0 0 3.25 1.95 2.25 2.25 0 1 0 0-1.51A2.75 2.75 0 0 1 6.5 6.5V5.37c-.36-.05-.7-.12-1.05-.22ZM4.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm7 6.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM5.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
  closed:
    'M3.25 1A2.25 2.25 0 0 1 4 5.37v5.26a2.25 2.25 0 1 1-1.5 0V5.37A2.25 2.25 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.38a2.25 2.25 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.28L11.94 2.44l1.22-1.22a.75.75 0 1 1 1.06 1.06L13 3.5l1.22 1.22a.75.75 0 0 1-1.06 1.06L11.94 4.56l-1.22 1.22a.75.75 0 1 1-1.06-1.06L10.88 3.5 9.66 2.28a.75.75 0 0 1 1.06-1.06ZM3.25 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
}
OCTICON.draft = OCTICON.pr

const COLOR: Record<ThreadStatus, string> = {
  none: '',
  recent: 'text-info',
  active: 'text-info',
  wait: 'text-warning',
  pr: 'text-success',
  draft: 'text-subtle-foreground',
  merged: 'text-merged',
  closed: 'text-destructive',
}

export function ThreadStatusMark({
  status,
  detail,
  className,
}: {
  status: ThreadStatus
  /** Extra tooltip text, such as a pull request number. */
  detail?: string
  className?: string
}) {
  const { t } = useTranslation()
  const label =
    status === 'none' ? undefined : t(`common:shell.status.${status}`)
  const title = label && detail ? `${label} · ${detail}` : label
  const path = OCTICON[status]
  return (
    <span
      data-status={status}
      title={title}
      aria-label={title}
      role={title ? 'img' : undefined}
      className={cn(
        'relative grid size-3.5 shrink-0 place-items-center',
        COLOR[status],
        className
      )}
    >
      {path ? (
        <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
          <path fill="currentColor" d={path} />
        </svg>
      ) : status === 'none' ? null : (
        <span
          className={cn(
            'size-2 rounded-full bg-current',
            status === 'active' && 'motion-safe:animate-[blink_1.2s_ease-in-out_infinite]'
          )}
        />
      )}
    </span>
  )
}
