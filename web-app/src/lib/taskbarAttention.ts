import { isPlatformTauri } from '@/lib/platform/utils'

/**
 * Flash Flint's taskbar icon (bounce the Dock icon on macOS) while an approval
 * waits and Flint is not the window in front: a run paused on a question is
 * easy to miss from another window.
 *
 * The flash is asked for once per new request, and the OS stops it when Flint
 * is focused. Once nothing is waiting it is cleared, so an approval answered
 * elsewhere (another pane, a phone) does not leave the icon flashing.
 */
type Window = {
  requestUserAttention: (kind: number | null) => Promise<void>
}

/** The Tauri value for "until the user focuses the window". */
const CRITICAL = 1

let loadWindow: () => Promise<Window | null> = async () => {
  if (!isPlatformTauri()) return null
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

let flashing = false
const seen = new Set<string>()

const request = (kind: number | null) =>
  void loadWindow()
    .then((w) => w?.requestUserAttention(kind))
    // Attention is a nicety: a platform without it is not an error.
    .catch(() => undefined)

/** Called with the ids waiting now, whenever they change. */
export function syncTaskbarAttention(
  waitingIds: readonly string[],
  focused: boolean = typeof document === 'undefined' || document.hasFocus()
): void {
  const live = new Set(waitingIds)
  for (const id of seen) if (!live.has(id)) seen.delete(id)
  const fresh = waitingIds.filter((id) => !seen.has(id))
  for (const id of fresh) seen.add(id)

  if (waitingIds.length === 0) {
    if (flashing) request(null)
    flashing = false
    return
  }
  if (fresh.length > 0 && !focused) {
    request(CRITICAL)
    flashing = true
  }
}

/** For tests. */
export function resetTaskbarAttentionForTests(
  load?: () => Promise<Window | null>
): void {
  flashing = false
  seen.clear()
  if (load) loadWindow = load
}
