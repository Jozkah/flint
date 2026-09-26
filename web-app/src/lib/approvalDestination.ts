/**
 * Where a waiting approval prompt lives, and how to take the user there.
 *
 * An approval request names the conversation that raised it by `threadId`:
 * a Cowork session id, a room id, or a chat thread id. The reminder toast
 * uses this to open that conversation and bring the prompt into view.
 */
import { route } from '@/constants/routes'

export type ApprovalDestination =
  | { kind: 'cowork'; id: string }
  | { kind: 'room'; id: string }
  | { kind: 'thread'; id: string }

export function approvalDestination(
  threadId: string,
  known: { coworkSessionIds: Iterable<string>; roomIds: Iterable<string> }
): ApprovalDestination {
  if (new Set(known.coworkSessionIds).has(threadId)) {
    return { kind: 'cowork', id: threadId }
  }
  if (new Set(known.roomIds).has(threadId)) return { kind: 'room', id: threadId }
  return { kind: 'thread', id: threadId }
}

export type ApprovalNavigate = (options: {
  to: string
  params?: Record<string, string>
}) => unknown

/** Navigate to the destination; a Cowork session is selected first. */
export function openApprovalDestination(
  destination: ApprovalDestination,
  navigate: ApprovalNavigate,
  selectCoworkSession: (id: string) => void
): void {
  switch (destination.kind) {
    case 'cowork':
      selectCoworkSession(destination.id)
      void navigate({ to: route.cowork })
      return
    case 'room':
      void navigate({
        to: route.roomDetail,
        params: { roomId: destination.id },
      })
      return
    case 'thread':
      void navigate({
        to: route.threadsDetail,
        params: { threadId: destination.id },
      })
  }
}

/**
 * Scroll the prompt for `requestId` into view once the conversation has
 * rendered it. Polls briefly because navigation and the transcript render
 * after the click; gives up quietly when the prompt never appears (it was
 * answered, or it lives in a collapsed card).
 */
export function scrollToApproval(
  requestId: string,
  options: { tries?: number; everyMs?: number; root?: ParentNode } = {}
): Promise<boolean> {
  const tries = options.tries ?? 20
  const everyMs = options.everyMs ?? 100
  const root = options.root ?? document
  const selector = `[data-approval-request="${CSS.escape(requestId)}"]`
  return new Promise((resolve) => {
    let left = tries
    const attempt = () => {
      const el = root.querySelector<HTMLElement>(selector)
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        resolve(true)
        return
      }
      if (--left <= 0) {
        resolve(false)
        return
      }
      setTimeout(attempt, everyMs)
    }
    attempt()
  })
}
