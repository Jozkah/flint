import { sameBinding, type Binding } from '@/lib/coworkReadiness'

/**
 * Turning direct editing on, in the order that keeps it honest.
 *
 * The ordering is the whole content: ask the backend first, and only then
 * change what the session says about itself. Setting the preference first
 * would show "editable" for the length of a round trip that might refuse.
 *
 * It lives here, taking its collaborators as arguments, because the race it
 * guards against is only visible when a reply is made to arrive after the user
 * has moved on — and that is unreasonable to stage through a mounted route.
 * The route keeps the wiring; this keeps the decision.
 */

export type AuthorizeDeps = {
  /** The session and folder the user is asking about. */
  binding: Binding
  /** Jan's data folder, needed by the backend to validate the root. */
  dataFolder: string | null
  /** Issues the grant. Resolves false-ish when the backend refused. */
  authorize: (
    sessionId: string,
    folder: string,
    dataFolder: string
  ) => Promise<{ ok: boolean }>
  /** Hands a grant back. Idempotent, and safe to call when none exists. */
  revokeSession: (sessionId: string) => Promise<boolean>
  /**
   * Where the user is *now*, read after the await.
   *
   * A function rather than a value: the point is to see the binding as it
   * stands when the answer arrives, not as it stood when the question was
   * asked.
   */
  currentBinding: () => Binding
  /** Records the preference, once something backs it. */
  setAccess: (sessionId: string) => void
}

export type AuthorizeResult =
  | 'granted'
  /** The backend refused, or there was nothing to ask about. */
  | 'refused'
  /**
   * A grant arrived for a session or folder the user has already left. It was
   * handed straight back: a grant nobody is looking at is live authority with
   * no one accountable for it.
   */
  | 'stale'

export async function authorizeDirectEdit(
  deps: AuthorizeDeps
): Promise<AuthorizeResult> {
  const { sessionId, folder } = deps.binding
  if (!sessionId || !folder || !deps.dataFolder) return 'refused'

  const outcome = await deps.authorize(sessionId, folder, deps.dataFolder)
  if (!outcome.ok) return 'refused'

  // The question was about one session and one folder, and both can change
  // while the backend is answering.
  if (!sameBinding(deps.binding, deps.currentBinding())) {
    await deps.revokeSession(sessionId)
    return 'stale'
  }

  deps.setAccess(sessionId)
  return 'granted'
}
