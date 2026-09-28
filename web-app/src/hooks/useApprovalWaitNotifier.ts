import { createElement, useEffect, useRef } from 'react'
import { syncTaskbarAttention } from '@/lib/taskbarAttention'
import { toast } from 'sonner'
import {
  approvalDestination,
  openApprovalDestination,
  scrollToApproval,
  type ApprovalNavigate,
} from '@/lib/approvalDestination'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useRoomsStore } from '@/lib/rooms/store'
import { emitRemoteNotification } from '@/lib/remote/events'
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
 * Open the conversation a waiting prompt belongs to (a chat thread, a Cowork
 * session or a room), bring the prompt into view, and dismiss its reminder.
 */
export function openWaitingApproval(
  entry: Pick<PendingApproval, 'requestId' | 'threadId'>,
  navigate: ApprovalNavigate
): void {
  const destination = approvalDestination(entry.threadId, {
    coworkSessionIds: useCoworkSessions.getState().sessions.map((s) => s.id),
    roomIds: useRoomsStore.getState().summaries.map((r) => r.id),
  })
  openApprovalDestination(destination, navigate, (id) =>
    useCoworkSessions.getState().selectSession(id)
  )
  toast.dismiss(`approval-wait-${entry.requestId}`)
  void scrollToApproval(entry.requestId)
}

/**
 * The reminder's content: one button, so the whole toast is a pointer
 * target, focusable, and answers Enter and Space.
 */
export function approvalReminderContent(
  title: string,
  body: string,
  onOpen: () => void
) {
  return createElement(
    'button',
    {
      type: 'button',
      onClick: onOpen,
      'data-testid': 'approval-wait-open',
      className:
        'flex w-full cursor-pointer flex-col items-start gap-0.5 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    },
    createElement('span', { className: 'font-medium' }, title),
    createElement(
      'span',
      { className: 'text-muted-foreground text-xs' },
      body
    )
  )
}

/**
 * Remind the user of approval prompts that have waited over 30 seconds: a
 * toast that stays until the prompt is answered, and a system notification
 * while the window is in the background. The taskbar icon flashes as soon as
 * a prompt arrives in the background. Mounted once, in the app shell.
 */
export function useApprovalWaitNotifier(navigate?: ApprovalNavigate): void {
  // Read at click time, so the effect below never restarts for a new router
  // function identity.
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  useEffect(() => {
    const reminded = new Set<string>()
    const check = () => {
      const entries = allApprovalRequests(useToolApprovalRequests.getState())
      const live = new Set(entries.map((e) => e.requestId))
      // At once, not after the reminder delay: the taskbar icon flashes as
      // soon as a run stops to ask while Flint is in the background.
      syncTaskbarAttention(entries.map((e) => e.requestId))
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
        const open = () => {
          if (navigateRef.current) openWaitingApproval(entry, navigateRef.current)
        }
        toast.info(approvalReminderContent(title, body, open), {
          id: `approval-wait-${entry.requestId}`,
          duration: Infinity,
        })
        osNotify(title, body)
        // A paired phone is often where the user is while a run waits.
        emitRemoteNotification(title, body)
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
