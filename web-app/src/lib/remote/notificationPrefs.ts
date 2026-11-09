// Per-phone notification choices, kept in local storage.

import type { NotificationPrefs } from './protocol'

const NOTIFY_KEY = 'flint-remote-notification-prefs'

/** Per-phone notification choices, kept for the push notifications to come. */
export function readNotificationPrefs(device: string): NotificationPrefs | null {
  try {
    const all = JSON.parse(localStorage.getItem(NOTIFY_KEY) ?? '{}') as Record<string, NotificationPrefs>
    return all[device] ?? null
  } catch {
    return null
  }
}

export function writeNotificationPrefs(device: string, prefs: NotificationPrefs) {
  try {
    let all: Record<string, NotificationPrefs> = {}
    try {
      const parsed = JSON.parse(localStorage.getItem(NOTIFY_KEY) ?? '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        all = parsed as Record<string, NotificationPrefs>
      }
    } catch {
      // Corrupt stored value: start over so this write still lands.
    }
    all[device] = prefs
    localStorage.setItem(NOTIFY_KEY, JSON.stringify(all))
  } catch {
    // Storage unavailable: the phone keeps its own copy.
  }
}
