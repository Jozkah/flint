// The remote-access wire protocol: push notifications. Re-exported by
// protocol.ts; free of app imports.

// ---------------------------------------------------------------------------
// Push (answered by the server itself, not the window)
// ---------------------------------------------------------------------------

export type PushCategory =
  | 'approval'
  | 'runFinished'
  | 'runFailed'
  | 'pr'
  | 'roomWaiting'
  | 'synthesis'
  | 'chatReply'
  | 'test'

export type PushNotice = {
  category: PushCategory
  title: string
  body: string
  /** In-app path, `/m/#/...`. */
  url: string
  /** Collapses notifications about the same thing. */
  tag: string
  requestId?: string
}

export type PushPrefs = {
  approvals: boolean
  runFinished: boolean
  runFailed: boolean
  pr: boolean
  roomWaiting: boolean
  synthesis: boolean
  chatReply: boolean
  hideContent: boolean
  /** Minutes after local midnight; approvals still come through. */
  quietHours: { enabled: boolean; start: number; end: number }
  utcOffsetMinutes: number
}

export type PushSubscriptionJson = { endpoint: string; keys: { p256dh: string; auth: string } }

/** What the service worker receives. */
export type PushPayload = {
  title: string
  body: string
  url: string
  tag: string
  category: PushCategory
  requestId?: string
}
