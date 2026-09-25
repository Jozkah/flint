import { useEffect } from 'react'
import { toast } from 'sonner'
import {
  allApprovalRequests,
  useToolApprovalRequests,
  type PendingApproval,
} from '@/hooks/useToolApprovalRequests'

/** How long a prompt may wait before the user is reminded of it. */
export const APPROVAL_WAIT_REMINDER_MS = 30_000

const CHECK_EVERY_MS = 5_000

/**
 * The requests that have waited at least APPROVAL_WAIT_REMINDER_MS and were
 * not reminded of yet. A run can sit for minutes on a prompt the user never
 * saw (another chat open, the window in the background), so it gets one
 * reminder per request.
 */
export function approvalsWaitingTooLong(
  entries: readonly PendingApproval[],
  now: number,
  reminded: ReadonlySet<string>
): PendingApproval[] {
  return entries.filter(
    (e) =>
      e.requestedAt !== undefined &&
      now - e.requestedAt >= APPROVAL_WAIT_REMINDER_MS &&
      !reminded.has(e.requestId)
  )
}

function osNotify(title: string, body: string): void {
  try {
    if (typeof document === 'undefined' || !document.hidden) return
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    new Notification(title, { body })
  } catch {
    // Notifications are a nicety; the toast still shows.
  }
}

/**
 * Remind the user of approval prompts that have waited over 30 seconds: a
 * toast that stays until the prompt is answered, and a system notification
 * while the window is in the background. Mounted once, in the app shell.
 */
export function useApprovalWaitNotifier(): void {
  useEffect(() => {
    const reminded = new Set<string>()
    const check = () => {
      const entries = allApprovalRequests(useToolApprovalRequests.getState())
      const live = new Set(entries.map((e) => e.requestId))
      // An answered or withdrawn prompt takes its reminder with it.
      for (const id of reminded) {
        if (!live.has(id)) {
          toast.dismiss(`approval-wait-${id}`)
          reminded.delete(id)
        }
      }
      const now = Date.now()
      for (const entry of approvalsWaitingTooLong(entries, now, reminded)) {
        reminded.add(entry.requestId)
        const seconds = Math.round((now - (entry.requestedAt ?? now)) / 1000)
        const title = `Waiting for your approval: ${entry.toolName}`
        const body = `The run has been paused for ${seconds} s until you allow or deny it.`
        toast.info(title, {
          id: `approval-wait-${entry.requestId}`,
          description: body,
          duration: Infinity,
        })
        osNotify(title, body)
      }
    }
    const timer = setInterval(check, CHECK_EVERY_MS)
    const unsubscribe = useToolApprovalRequests.subscribe(check)
    return () => {
      clearInterval(timer)
      unsubscribe()
      for (const id of reminded) toast.dismiss(`approval-wait-${id}`)
    }
  }, [])
}
