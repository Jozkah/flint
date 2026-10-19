import { create } from 'zustand'

/**
 * The question asked before Bypass is switched on, once per app run. Bypass
 * runs every tool call without asking, host commands included, so the first
 * switch states that plainly; after a yes the person has been told, and the
 * mode picker does not nag on each later switch.
 *
 * Asked through the app's own dialog (`BypassConfirmDialog`, mounted once at
 * the root), not a native `window.confirm`, which is unthemed and blocks the
 * webview's debugging and automation channel while it is open.
 */
let confirmed = false

type Request = { message: string; resolve: (ok: boolean) => void }

export const useBypassConfirm = create<{ request: Request | null }>(() => ({
  request: null,
}))

/** Settle the open question, if any. */
export function answerBypassConfirm(ok: boolean): void {
  const request = useBypassConfirm.getState().request
  if (!request) return
  useBypassConfirm.setState({ request: null })
  if (ok) confirmed = true
  request.resolve(ok)
}

/** True when Bypass may be switched on: already confirmed, or the person says yes now. */
export function confirmBypass(message: string): Promise<boolean> {
  if (confirmed) return Promise.resolve(true)
  // A second ask while one is open replaces nothing: the earlier one is
  // answered no, so no caller is left waiting.
  answerBypassConfirm(false)
  return new Promise<boolean>((resolve) => {
    useBypassConfirm.setState({ request: { message, resolve } })
  })
}

/** Test seam: forget the confirmation. */
export function resetBypassConfirm(): void {
  confirmed = false
  useBypassConfirm.setState({ request: null })
}
