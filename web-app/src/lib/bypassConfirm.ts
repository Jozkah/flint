/**
 * The question asked before Bypass is switched on, once per app run. Bypass
 * runs every tool call without asking, host commands included, so the first
 * switch states that plainly; after a yes the person has been told, and the
 * mode picker does not nag on each later switch.
 */
let confirmed = false

/** True when Bypass may be switched on: already confirmed, or the person says yes now. */
export function confirmBypass(message: string): boolean {
  if (confirmed) return true
  if (typeof window === 'undefined' || !window.confirm(message)) return false
  confirmed = true
  return true
}

/** Test seam: forget the confirmation. */
export function resetBypassConfirm(): void {
  confirmed = false
}
