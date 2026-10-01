/**
 * A desktop notification for something that took a while, shown only when the
 * window is not in front: a person watching the progress bar does not need a
 * pop-up telling them what they are looking at.
 *
 * Uses the webview's own Notification API, so no extra plugin or permission
 * entry is needed. Permission is asked for from a user action (starting the
 * job), never in the middle of an event the person did not cause. Everything
 * here is best-effort: a webview without notifications simply shows nothing.
 */

type NotificationApi = {
  permission: NotificationPermission
  requestPermission: () => Promise<NotificationPermission>
}

const api = (): NotificationApi | null => {
  try {
    return typeof Notification === 'undefined' ? null : (Notification as unknown as NotificationApi)
  } catch {
    return null
  }
}

/** Ask once, from a click, so a later `notifyInBackground` can show something. */
export async function allowNotifications(): Promise<void> {
  const n = api()
  if (!n || n.permission !== 'default') return
  try {
    await n.requestPermission()
  } catch {
    // Not available here.
  }
}

/** Show `title` and `body` if the window is hidden or unfocused and the person allowed it. */
export function notifyInBackground(title: string, body?: string): boolean {
  const n = api()
  if (!n || n.permission !== 'granted') return false
  if (typeof document !== 'undefined' && document.hasFocus() && document.visibilityState === 'visible') return false
  try {
    new Notification(title, body ? { body } : undefined)
    return true
  } catch {
    return false
  }
}
